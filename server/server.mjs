// Sitting Pretty local demo server.
// Pure Node >= 20, zero npm dependencies. Serves the static site AND the /api/*
// contract from API.md on the same origin. JSON persistence in server/db.json.
// Run: node server/server.mjs   (env: PORT, ADMIN_EMAILS, STRIPE_SECRET_KEY)

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderNotification } from './templates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(__dirname, 'db.json');
const PORT = Number(process.env.PORT || 4870);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'ebony@demo.local')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const TZ = 'America/Chicago';
const OUTBOX_CAP = 200;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
// Demo helpers (/api/_outbox, /api/_reset) are on by default for local use.
// Set DEMO=0 to hide them.
const DEMO = process.env.DEMO !== '0';
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_REQUESTS = 5;
const DEPOSIT_DEADLINE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Sessions: 90 days, sliding. Every authenticated request pushes the expiry
// back out so repeat clients stay signed in. The new expiry is only written to
// disk once an hour per session to keep writes cheap.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 60 * 60 * 1000;

// Password sign-in: 8 failed attempts per 15 minutes, per email and per IP.
// Only failures count, so someone typing the right password is never locked out.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

// Google OAuth. If both env vars are set the real Google flow runs; otherwise
// the local demo account chooser stands in for it.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const googleConfigured = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// Seeded demo client tasha@demo.local gets this password so the password path
// is testable the moment the server boots. Documented in server/README.md.
const DEMO_CLIENT_PASSWORD = 'SittingPretty2026';

class ApiError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

/* ---------------- service catalog (derived from services-data.js) ---------- */

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseDuration(s) {
  if (!s) return null;
  let mins = 0;
  const hr = /(\d+)\s*hr/i.exec(s);
  const min = /(\d+)\s*min/i.exec(s);
  if (hr) mins += Number(hr[1]) * 60;
  if (min) mins += Number(min[1]);
  return mins || null;
}

function parseDeposit(note, price) {
  const m = /\$(\d+)\s*deposit/i.exec(note || '');
  if (m) return Number(m[1]) * 100;
  if (/paid in full|pay in full|full payment/i.test(note || '')) {
    const p = /(\d+(?:\.\d+)?)/.exec(price || '');
    if (p) return Math.round(Number(p[1]) * 100);
  }
  return null;
}

function buildCatalog() {
  // services-data.js is first-party data shipped with this repo, so executing
  // its literal via the Function constructor is acceptable here.
  const src = fs.readFileSync(path.join(ROOT, 'services-data.js'), 'utf8');
  const literal = src
    .replace(/^[\s\S]*?const\s+SERVICES\s*=\s*/, '')
    .replace(/;\s*$/, '');
  const raw = new Function('return (' + literal + ')')();
  const categories = raw.map((group) => ({
    cat: group.cat,
    items: group.items.map(([name, price, duration, note]) => ({
      service_id: slugify(group.cat + '--' + name),
      name,
      price,
      duration_min: parseDuration(duration),
      deposit_cents: parseDeposit(note, price),
      note: note || ''
    }))
  }));
  const byId = new Map();
  for (const c of categories) for (const it of c.items) byId.set(it.service_id, it);
  return { categories, byId };
}

const catalog = buildCatalog();

/* ---------------- time helpers (America/Chicago) --------------------------- */

function chicagoNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return {
    date: get('year') + '-' + get('month') + '-' + get('day'),
    minutes: Number(hour) * 60 + Number(get('minute'))
  };
}

function weekdayOf(dateStr) {
  // Calendar weekday of a YYYY-MM-DD date (timezone independent). 0 = Sunday.
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

function dateOffset(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toMin(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function toHHMM(mins) {
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}

// Hours: Sun closed, Mon-Fri 09:00-20:00, Sat 09:00-18:00.
function businessHours(dateStr) {
  const wd = weekdayOf(dateStr);
  if (wd === 0) return null;
  return { open: 9 * 60, close: (wd === 6 ? 18 : 20) * 60 };
}

/* ---------------- persistence ---------------------------------------------- */

let db = null;
let saveTimer = null;

function defaultDb() {
  return {
    clients: [], bookings: [], sessions: {}, codes: {}, oauth_states: {},
    checkout_sessions: {}, blocked_days: [], outbox: [], broadcasts: [],
    seq: {}
  };
}

// Bring a db.json written by an older build up to the current shape. Existing
// clients keep working: they simply have no password yet and sign in by code.
function normalizeDb() {
  if (!db.oauth_states) db.oauth_states = {};
  if (!db.sessions) db.sessions = {};
  for (const c of db.clients) {
    if (c.password_hash === undefined) c.password_hash = null;
    if (!c.auth_provider) c.auth_provider = 'code';
    if (c.google_linked === undefined) c.google_linked = false;
  }
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('[db] save failed:', e.message);
  }
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function nextId(kind) {
  db.seq[kind] = (db.seq[kind] || 0) + 1;
  return kind + '_' + db.seq[kind];
}

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db || !Array.isArray(db.clients)) throw new Error('malformed');
    normalizeDb();
    save();
  } catch {
    seedDemo();
    saveNow();
    console.log('[db] seeded fresh demo data at', DB_PATH);
  }
}

/* ---------------- demo seed ------------------------------------------------- */

function makeClient(email, name, phone, isAdmin, extra) {
  const c = {
    id: nextId('cl'), email, name: name || null, phone: phone || null,
    is_admin: !!isAdmin, created_at: new Date().toISOString(),
    password_hash: null, auth_provider: 'code', google_linked: false,
    ...(extra || {})
  };
  db.clients.push(c);
  return c;
}

function seedDemo() {
  db = defaultDb();
  const admin = makeClient('ebony@demo.local', "Ke'Ebonie Hill", '(817) 704-8300', true);
  const maya = makeClient('maya@demo.local', 'Maya Johnson', '(817) 555-0141', false);
  // Tasha ships with a known demo password so the password flow is testable
  // right away. Everyone else is code-only, like accounts made before passwords.
  const tasha = makeClient('tasha@demo.local', 'Tasha Reeves', '(682) 555-0163', false, {
    password_hash: hashPasswordSync(DEMO_CLIENT_PASSWORD), auth_provider: 'password'
  });
  const renee = makeClient('renee@demo.local', 'Renee Carter', '(214) 555-0128', false);
  void admin;

  // Next open days (skip Sundays), starting tomorrow.
  const days = [];
  let off = 1;
  const today = chicagoNow().date;
  while (days.length < 5) {
    const d = dateOffset(today, off++);
    if (weekdayOf(d) !== 0) days.push(d);
  }

  const seedBooking = (client, cat, name, date, time, status, extra) => {
    const svc = catalog.byId.get(slugify(cat + '--' + name));
    if (!svc) return null;
    const b = {
      id: nextId('bk'),
      client_id: client.id, client_name: client.name,
      client_email: client.email, client_phone: client.phone,
      service_id: svc.service_id, service_name: svc.name,
      price: svc.price, deposit_cents: svc.deposit_cents,
      date, time, duration_min: svc.duration_min || 30,
      status, notes: '', created_at: new Date().toISOString(),
      ...extra
    };
    db.bookings.push(b);
    return b;
  };

  // 5 demo bookings across the next week: 1 awaiting_deposit, 1 request,
  // 2 confirmed, 1 canceled.
  const awaiting = seedBooking(maya, 'Sew-ins', 'Traditional Sew In', days[0], '10:00', 'awaiting_deposit');
  if (awaiting) {
    const sid = 'demo_' + crypto.randomBytes(8).toString('hex');
    const payToken = crypto.randomBytes(16).toString('hex');
    db.checkout_sessions[sid] = {
      id: sid, booking_id: awaiting.id, amount_cents: awaiting.deposit_cents,
      paid: false, stripe: false,
      url: '/demo-checkout?session=' + sid + '&pay_token=' + payToken,
      pay_token: payToken, created_at: new Date().toISOString()
    };
    awaiting.checkout_session_id = sid;
  }
  seedBooking(tasha, 'Sew-ins', 'Closure Sew In', days[1], '13:00', 'request');
  seedBooking(renee, 'Braids', 'Medium Knotless Braids', days[2], '09:00', 'confirmed');
  seedBooking(maya, 'Quickweaves', 'Full Quick Weave', days[3], '15:00', 'confirmed');
  seedBooking(tasha, 'Locs & Dreads', 'Retwist Dreadlocks', days[4], '11:00', 'canceled', { canceled_by: 'client' });
}

/* ---------------- outbox and notifications ---------------------------------- */

function pushOutbox(channel, to, subject, body) {
  db.outbox.unshift({ ts: new Date().toISOString(), channel, to, subject: subject || null, body });
  if (db.outbox.length > OUTBOX_CAP) db.outbox.length = OUTBOX_CAP;
  save();
}

function notify(event, target, data) {
  // target: { email?, phone?, name? }
  const t = renderNotification(event, { ...data, name: target.name });
  if (t.email && target.email) pushOutbox('email', target.email, t.email.subject, t.email.body);
  if (t.sms && target.phone) pushOutbox('sms', target.phone, null, t.sms.body);
}

/* ---------------- passwords -------------------------------------------------- */

// scrypt with a fresh 16-byte salt per user. Stored as scrypt$N$salt$hash so the
// cost parameter can be raised later without breaking existing hashes.
// The plaintext password is never stored, logged, or returned.
const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_OPTS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;

// Short list of passwords that are guessed first in any real attack.
const TRIVIAL_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '123123123', '11111111', '00000000',
  'qwertyui', 'qwerty123', 'qwertyuiop', 'asdfghjkl', 'abc12345', 'abcd1234',
  'iloveyou', 'letmein1', 'welcome1', 'welcome123', 'admin123', 'changeme',
  'trustno1', 'sunshine1', 'princess1', 'football1', 'baseball1', 'monkey123',
  'dragon123', 'superman1', 'hairstylist', 'sittingpretty', 'beautiful1'
]);

function encodeHash(saltBuf, keyBuf, n) {
  return 'scrypt$' + n + '$' + saltBuf.toString('hex') + '$' + keyBuf.toString('hex');
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  return encodeHash(salt, crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS), SCRYPT_N);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return encodeHash(salt, key, SCRYPT_N);
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 1024) return false;
  let salt; let expected;
  try {
    salt = Buffer.from(parts[2], 'hex');
    expected = Buffer.from(parts[3], 'hex');
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  const actual = await scryptAsync(password, salt, expected.length, { ...SCRYPT_OPTS, N: n });
  return crypto.timingSafeEqual(actual, expected);
}

// Unknown emails are checked against this throwaway hash so a wrong password and
// a nonexistent account take the same amount of time (no timing enumeration).
const DECOY_HASH = hashPasswordSync(crypto.randomBytes(32).toString('hex'));

function assertPasswordOk(password, email) {
  if (typeof password !== 'string' || !password) {
    throw new ApiError(400, 'Please choose a password.');
  }
  if (password.length < PASSWORD_MIN) {
    throw new ApiError(400, 'Please use at least ' + PASSWORD_MIN + ' characters for your password.');
  }
  if (password.length > PASSWORD_MAX) {
    throw new ApiError(400, 'That password is too long. Please keep it under ' + PASSWORD_MAX + ' characters.');
  }
  const flat = password.trim().toLowerCase();
  const local = String(email || '').split('@')[0].toLowerCase();
  if (TRIVIAL_PASSWORDS.has(flat) || (local.length >= 4 && flat === local) || flat === String(email || '').toLowerCase()) {
    throw new ApiError(400, 'That password is too easy to guess. Please pick something else.');
  }
  return password;
}

/* ---------------- clients, auth, sessions ----------------------------------- */

function publicClient(c) {
  return {
    id: c.id, email: c.email, name: c.name, phone: c.phone,
    is_admin: !!c.is_admin,
    has_password: !!c.password_hash,
    auth_provider: c.auth_provider || 'code'
  };
}

function findClientByEmail(email) {
  return db.clients.find((c) => c.email === email) || null;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function bearerToken(req) {
  const m = /^Bearer\s+([A-Za-z0-9]{16,64})$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

// Opaque random token, stored server side only. auth_provider records how this
// sign-in happened; any existing password is left alone.
function startSession(client, provider) {
  if (provider) client.auth_provider = provider;
  client.is_admin = ADMIN_EMAILS.includes(client.email);
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  db.sessions[token] = {
    client_id: client.id,
    provider: provider || 'code',
    created_at: new Date(now).toISOString(),
    last_seen: new Date(now).toISOString(),
    expires: new Date(now + SESSION_TTL_MS).toISOString()
  };
  save();
  return token;
}

function endSession(token) {
  if (token && db.sessions[token]) { delete db.sessions[token]; save(); }
}

function endAllSessionsFor(clientId) {
  for (const [tok, s] of Object.entries(db.sessions)) {
    if (s.client_id === clientId) delete db.sessions[tok];
  }
  save();
}

function authClient(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const sess = db.sessions[token];
  if (!sess) return null;
  const now = Date.now();
  const expires = Date.parse(sess.expires || '') || 0;
  if (expires && expires <= now) { delete db.sessions[token]; save(); return null; }
  const client = db.clients.find((c) => c.id === sess.client_id) || null;
  if (!client) { delete db.sessions[token]; save(); return null; }
  // Sliding expiry: every authenticated request pushes the 90 days back out.
  const lastSeen = Date.parse(sess.last_seen || '') || 0;
  if (now - lastSeen > SESSION_TOUCH_MS) {
    sess.last_seen = new Date(now).toISOString();
    sess.expires = new Date(now + SESSION_TTL_MS).toISOString();
    save();
  }
  return client;
}

function requireAuth(req) {
  const c = authClient(req);
  if (!c) throw new ApiError(401, 'Sign in required');
  return c;
}

function requireAdmin(req) {
  const c = requireAuth(req);
  if (!c.is_admin) throw new ApiError(403, 'Admin only');
  return c;
}

/* ---------------- rate limiting (in-memory) --------------------------------- */

const rateBuckets = new Map(); // key -> [timestamps]

function recentHits(key, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length) rateBuckets.set(key, hits);
  else rateBuckets.delete(key);
  return hits;
}

// Consuming check: used by the code-request limits (5 per 15 min, unchanged).
function rateLimitHit(key, max = RATE_MAX_REQUESTS, windowMs = RATE_WINDOW_MS) {
  const hits = recentHits(key, windowMs);
  if (hits.length >= max) return true;
  hits.push(Date.now());
  rateBuckets.set(key, hits);
  return false;
}

// Non-consuming check plus an explicit recorder: used by password sign-in, where
// only failed attempts count against the limit.
function isRateLimited(key, max, windowMs) {
  return recentHits(key, windowMs).length >= max;
}

function recordFailure(key, windowMs) {
  const hits = recentHits(key, windowMs);
  hits.push(Date.now());
  rateBuckets.set(key, hits);
}

// Drops the most recent recorded attempt for a key. Sign-in records the attempt
// up front (so concurrent guesses cannot slip past the gate) and calls this on
// success, which keeps a client who knows her password from being locked out by
// someone else guessing from the same address.
function forgetFailure(key) {
  const hits = rateBuckets.get(key);
  if (!hits || !hits.length) return;
  hits.pop();
  if (hits.length) rateBuckets.set(key, hits);
  else rateBuckets.delete(key);
}

// Warm, specific wait message instead of a bare "too many requests".
function waitMinutes(keys, windowMs) {
  const now = Date.now();
  let oldest = now;
  for (const k of keys) {
    for (const t of (rateBuckets.get(k) || [])) if (t < oldest) oldest = t;
  }
  const mins = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 60000));
  return mins + (mins === 1 ? ' minute' : ' minutes');
}

/* ---------------- google sign-in --------------------------------------------- */

// The demo chooser and the real Google flow share everything except how the
// verified email is obtained, so switching to production is only a matter of
// setting GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.

// Only same-origin paths may be redirected back to (no open redirect), and the
// caller's own hash is dropped because we append #sp_token to it.
function safeRedirect(v) {
  let r = cleanStr(v, 300) || '/';
  if (!r.startsWith('/') || r.startsWith('//') || r.startsWith('/\\')) r = '/';
  const hash = r.indexOf('#');
  if (hash >= 0) r = r.slice(0, hash);
  return r || '/';
}

function purgeOauthStates() {
  const now = Date.now();
  for (const [k, v] of Object.entries(db.oauth_states || {})) {
    if (!v || (Date.parse(v.expires || '') || 0) <= now) delete db.oauth_states[k];
  }
}

// CSRF defense for the OAuth round trip: unguessable value minted here, stored
// server side with a 10 minute expiry, single use, checked in the callback.
// The real Google flow needs exactly this, so the demo uses it too.
// The state is paired with a nonce that only the browser which started the
// sign-in holds (in a cookie). Checking that the state merely exists is not
// enough: anyone can mint one, so a crafted callback link would silently sign
// a victim into the attacker's account. Both halves must match.
function createOauthState(redirect) {
  purgeOauthStates();
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(24).toString('hex');
  db.oauth_states[state] = {
    redirect,
    nonce,
    created_at: new Date().toISOString(),
    expires: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()
  };
  save();
  return { state, nonce };
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const OAUTH_NONCE_COOKIE = 'sp_oauth';

function peekOauthState(state) {
  const rec = db.oauth_states[state];
  if (!rec) return null;
  if ((Date.parse(rec.expires || '') || 0) <= Date.now()) {
    delete db.oauth_states[state];
    save();
    return null;
  }
  return rec;
}

function takeOauthState(state) {
  const rec = peekOauthState(state);
  if (!rec) return null;
  delete db.oauth_states[state];
  save();
  return rec;
}

function googleRedirectUri(origin) {
  return origin + '/api/auth/google/callback';
}

function googleAuthorizeUrl(state, origin) {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(origin),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  return GOOGLE_AUTH_URL + '?' + p.toString();
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { return null; }
}

// Production path: authorization-code exchange straight to Google over TLS. The
// id_token comes back on that direct server to server response, so its contents
// are trusted without a JWKS check; email_verified is still required.
async function googleProfileFromCode(code, origin) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: googleRedirectUri(origin),
    grant_type: 'authorization_code'
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(502, 'Google sign-in did not go through. Please try again or use your email.');
  }
  const claims = decodeJwtPayload(json.id_token);
  const verified = claims && (claims.email_verified === true || claims.email_verified === 'true');
  if (!claims || !isEmail(claims.email) || !verified) {
    throw new ApiError(401, 'Google could not confirm that email address. Please try another way in.');
  }
  return { email: String(claims.email).toLowerCase(), name: cleanStr(claims.name, 100) || null };
}

// One account per email. A Google sign-in for an existing client signs into that
// same client and leaves the password (and everything else) intact.
function upsertGoogleClient(email, name) {
  let client = findClientByEmail(email);
  if (!client) {
    client = makeClient(email, name || null, null, ADMIN_EMAILS.includes(email), {
      auth_provider: 'google', google_linked: true
    });
  } else {
    if (!client.name && name) client.name = name;
    client.google_linked = true;
  }
  return client;
}

/* ---------------- availability ---------------------------------------------- */

function availability(svc, dateStr) {
  const out = { date: dateStr, closed: false, blocked: false, slots: [] };
  const hours = businessHours(dateStr);
  if (!hours) { out.closed = true; return out; }
  if (db.blocked_days.some((b) => b.date === dateStr)) { out.blocked = true; return out; }

  const now = chicagoNow();
  if (dateStr < now.date) return out; // past day: no slots

  const dur = svc.duration_min || 30;
  const lastStart = hours.close - dur;
  const dayBookings = db.bookings.filter((b) => b.date === dateStr && b.status !== 'canceled');

  for (let t = hours.open; t <= lastStart; t += 30) {
    if (dateStr === now.date && t <= now.minutes) continue; // never offer past times today
    const clash = dayBookings.some((b) => {
      const bs = toMin(b.time);
      const bd = b.duration_min || 30;
      return t < bs + bd && t + dur > bs; // one client at a time
    });
    if (!clash) out.slots.push(toHHMM(t));
  }
  return out;
}

/* ---------------- payments --------------------------------------------------- */

// kind: 'deposit' locks the appointment in; 'balance' is the rest of the price,
// paid online later by a client who would rather not settle up in the chair.
async function createCheckout(booking, origin, kind = 'deposit', amountCents = null) {
  const amount = amountCents == null ? booking.deposit_cents : amountCents;
  const label = kind === 'balance'
    ? 'Balance: ' + booking.service_name
    : 'Deposit: ' + booking.service_name;
  // pay_token: one-time unguessable secret embedded in the checkout URL so the
  // (unauthenticated, same-origin) demo checkout page can prove it belongs to
  // this session. Ownership can also be proven with the client's auth token.
  const payToken = crypto.randomBytes(16).toString('hex');
  if (STRIPE_KEY) {
    const p = new URLSearchParams();
    p.set('mode', 'payment');
    p.set('success_url', origin + '/?paid=1&booking=' + booking.id);
    p.set('cancel_url', origin + '/?canceled=1&booking=' + booking.id);
    p.set('line_items[0][quantity]', '1');
    p.set('line_items[0][price_data][currency]', 'usd');
    p.set('line_items[0][price_data][unit_amount]', String(amount));
    p.set('line_items[0][price_data][product_data][name]', label);
    p.set('metadata[booking_id]', booking.id);
    p.set('metadata[kind]', kind);
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + STRIPE_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: p.toString()
    });
    const json = await res.json();
    if (!res.ok) {
      throw new ApiError(502, 'Stripe error: ' + (json.error && json.error.message || res.status));
    }
    db.checkout_sessions[json.id] = {
      id: json.id, booking_id: booking.id, amount_cents: amount, kind,
      paid: false, stripe: true, url: json.url, pay_token: payToken,
      created_at: new Date().toISOString()
    };
    return { id: json.id, url: json.url };
  }
  const sid = 'demo_' + crypto.randomBytes(8).toString('hex');
  const url = '/demo-checkout?session=' + sid + '&pay_token=' + payToken;
  db.checkout_sessions[sid] = {
    id: sid, booking_id: booking.id, amount_cents: amount, kind,
    paid: false, stripe: false, url, pay_token: payToken,
    created_at: new Date().toISOString()
  };
  return { id: sid, url };
}

// Total from her price string. "$150" is exact; "$50+" and anything else with a
// plus means the final number depends on length, hair, or add-ons, so it is
// settled with her in person and never charged online as if it were fixed.
function totalCentsFor(booking) {
  const raw = String(booking.price || '');
  if (/\+/.test(raw)) return null;
  const m = raw.match(/\d+/);
  return m ? parseInt(m[0], 10) * 100 : null;
}

function paidCents(booking) {
  return booking.paid_cents || 0;
}

// Everything the UI needs to talk about money, derived so it can never drift
// from the stored payments.
function withMoney(booking) {
  return {
    ...booking,
    paid_cents: paidCents(booking),
    total_cents: totalCentsFor(booking),
    balance_cents: balanceCentsFor(booking),
    paid_in_full: !!booking.paid_in_full
  };
}

// What the client can still pay online: the fixed total minus what has landed.
// null means "not payable online" (variable price, or nothing left owing).
function balanceCentsFor(booking) {
  if (booking.paid_in_full) return null;
  const total = totalCentsFor(booking);
  if (total == null) return null;
  const left = total - paidCents(booking);
  return left > 0 ? left : null;
}

// Adds a payment and keeps the paid-in-full flag honest.
function applyPayment(booking, amountCents) {
  booking.paid_cents = paidCents(booking) + (amountCents || 0);
  const total = totalCentsFor(booking);
  if (total != null && booking.paid_cents >= total) booking.paid_in_full = true;
}

function safeTokenEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length > 0 && ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Checkout endpoints: allow the booking's owner (or admin) via auth token, or
// anyone presenting the session's one-time pay_token from the checkout URL.
function requireCheckoutAccess(req, url, session, booking) {
  const client = authClient(req);
  if (client && (client.is_admin || client.id === booking.client_id)) return;
  const pt = url.searchParams.get('pay_token') || '';
  if (session.pay_token && safeTokenEqual(pt, session.pay_token)) return;
  throw new ApiError(403, 'You do not have access to this checkout');
}

// A booking can only take money while it is still waiting on one. Anything
// canceled or already finished must refuse payment: a stale checkout link
// sitting in an old email must never charge someone for an appointment that
// is not going to happen.
function isPayable(booking) {
  return booking.status === 'awaiting_deposit' || booking.status === 'request';
}

function markDepositPaid(booking, amountCents) {
  if (isPayable(booking)) {
    booking.status = 'confirmed';
    booking.deposit_paid_at = new Date().toISOString();
    applyPayment(booking, amountCents == null ? booking.deposit_cents : amountCents);
    notify('booking_confirmed',
      { email: booking.client_email, phone: booking.client_phone, name: booking.client_name },
      { booking, balance_cents: balanceCentsFor(booking) });
    save();
  }
}

// The rest of the price, paid online instead of in the chair.
function markBalancePaid(booking, amountCents) {
  applyPayment(booking, amountCents);
  booking.paid_in_full = true;
  notify('balance_paid',
    { email: booking.client_email, phone: booking.client_phone, name: booking.client_name },
    { booking });
  save();
}

/* ---------------- deposit deadline sweeper ----------------------------------- */

// Her policy: deposits must be paid within 24 hours of booking or the
// appointment is cancelled. Runs on boot, every 15 minutes, and lazily before
// availability/bookings reads so the promise in the UI is actually enforced.
function sweepExpiredDeposits() {
  if (!db) return;
  const cutoff = Date.now() - DEPOSIT_DEADLINE_MS;
  let changed = false;
  for (const b of db.bookings) {
    if (b.status !== 'awaiting_deposit') continue;
    const created = Date.parse(b.created_at);
    if (Number.isNaN(created) || created >= cutoff) continue;
    b.status = 'canceled';
    b.canceled_by = 'system';
    notify('booking_canceled_deposit_unpaid',
      { email: b.client_email, phone: b.client_phone, name: b.client_name },
      { booking: b });
    changed = true;
  }
  if (changed) save();
}

// Housekeeping for expired sessions and OAuth states. Sessions are also checked
// on every authenticated request; this just keeps db.json from growing.
function sweepExpiredSessions() {
  if (!db) return;
  const now = Date.now();
  let changed = false;
  for (const [tok, s] of Object.entries(db.sessions)) {
    const exp = Date.parse(s.expires || '') || 0;
    if (exp && exp <= now) { delete db.sessions[tok]; changed = true; }
  }
  const states = Object.keys(db.oauth_states || {}).length;
  purgeOauthStates();
  if (changed || states !== Object.keys(db.oauth_states || {}).length) save();
}

/* ---------------- API router -------------------------------------------------- */

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new ApiError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new ApiError(400, 'Invalid JSON body')); }
    });
    req.on('error', () => reject(new ApiError(400, 'Bad request')));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendRedirect(res, location, extraHeaders) {
  res.writeHead(302, Object.assign({ Location: location, 'Cache-Control': 'no-store' }, extraHeaders || {}));
  res.end();
}

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max || 200);
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const origin = 'http://' + (req.headers.host || 'localhost:' + PORT);
  let m;

  // Enforce the 24-hour deposit deadline before anything that reads
  // availability or bookings.
  if (p === '/api/availability' || p === '/api/me' || p === '/api/bookings' || p === '/api/admin/bookings') {
    sweepExpiredDeposits();
  }

  /* -- auth: password -- */
  if (method === 'POST' && p === '/api/auth/signup') {
    const body = await readBody(req);
    const email = cleanStr(body.email, 200).toLowerCase();
    if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address');
    const ip = clientIp(req);
    if (rateLimitHit('signup-ip:' + ip, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS)) {
      throw new ApiError(429, 'Too many sign-up attempts. Please wait about ' +
        waitMinutes(['signup-ip:' + ip], LOGIN_WINDOW_MS) + ' and try again.');
    }
    const password = typeof body.password === 'string' ? body.password : '';
    assertPasswordOk(password, email);
    // The owner account is never claimable by whoever signs up first with her
    // address. She signs in with an email code (which proves she owns the
    // inbox) and sets a password from there.
    if (ADMIN_EMAILS.includes(email) && !findClientByEmail(email)) {
      throw new ApiError(403,
        'This address is the owner account. Sign in with an email code, then set a password.');
    }
    if (findClientByEmail(email)) {
      // Same message whether or not that account has a password: point them at
      // signing in and say nothing more.
      throw new ApiError(409, 'That email already has an account. Please sign in, or use a sign-in code to set a new password.');
    }
    const client = makeClient(email, cleanStr(body.name, 100) || null, cleanStr(body.phone, 30) || null,
      ADMIN_EMAILS.includes(email), { password_hash: await hashPassword(password), auth_provider: 'password' });
    const token = startSession(client, 'password');
    save();
    return sendJson(res, 200, { token, client: publicClient(client) });
  }

  if (method === 'POST' && p === '/api/auth/login') {
    const body = await readBody(req);
    const email = cleanStr(body.email, 200).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = clientIp(req);
    const emailKey = 'login-email:' + email;
    const ipKey = 'login-ip:' + ip;
    if (isRateLimited(emailKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS) ||
        isRateLimited(ipKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS)) {
      throw new ApiError(429, 'Too many sign-in attempts. Please wait about ' +
        waitMinutes([emailKey, ipKey], LOGIN_WINDOW_MS) +
        ' and try again, or sign in with an email code instead.');
    }
    // Count the attempt BEFORE the async password check. Verifying a scrypt
    // hash yields the event loop, so recording only on failure let a burst of
    // concurrent requests all clear the gate before any of them was counted.
    recordFailure(emailKey, LOGIN_WINDOW_MS);
    recordFailure(ipKey, LOGIN_WINDOW_MS);
    const forgiveAttempt = () => {
      forgetFailure(emailKey);
      forgetFailure(ipKey);
    };
    // One message for a wrong password and for an email with no account, so this
    // endpoint never tells an attacker which emails are real.
    const wrong = 'That email and password do not match. Please try again.';
    if (!isEmail(email) || !password) {
      throw new ApiError(401, wrong);
    }
    const client = findClientByEmail(email);
    if (!client) {
      await verifyPassword(password, DECOY_HASH); // keep the timing identical
      throw new ApiError(401, wrong);
    }
    if (!client.password_hash) {
      // Older account made by email code only. This stays counted: leaving it
      // unthrottled turned it into an unlimited oracle for which of her
      // clients have accounts.
      await verifyPassword(password, DECOY_HASH); // same timing as every other path
      throw new ApiError(409,
        'This account does not have a password yet. Sign in with an email code, then set one.',
        { needs_password_setup: true });
    }
    if (!(await verifyPassword(password, client.password_hash))) {
      throw new ApiError(401, wrong);
    }
    forgiveAttempt(); // correct password: do not hold it against her
    const token = startSession(client, 'password');
    save();
    return sendJson(res, 200, { token, client: publicClient(client) });
  }

  if (method === 'POST' && p === '/api/auth/set-password') {
    const client = requireAuth(req);
    const body = await readBody(req);
    const password = typeof body.password === 'string' ? body.password : '';
    assertPasswordOk(password, client.email);
    client.password_hash = await hashPassword(password);
    client.auth_provider = 'password';
    // Rotate: every session for this client is dropped and a fresh token issued,
    // so an old token cannot outlive a password change.
    endAllSessionsFor(client.id);
    const token = startSession(client, 'password');
    save();
    return sendJson(res, 200, { client: publicClient(client), token });
  }

  if (method === 'POST' && p === '/api/auth/logout') {
    requireAuth(req);
    endSession(bearerToken(req));
    return sendJson(res, 200, { ok: true });
  }

  /* -- auth: google -- */
  if (method === 'GET' && p === '/api/auth/google/start') {
    const redirect = safeRedirect(url.searchParams.get('redirect'));
    const { state, nonce } = createOauthState(redirect);
    // Ties this sign-in to this browser. Same-site lax keeps the cookie on the
    // way back from Google while blocking cross-site attempts to use it.
    const cookie = OAUTH_NONCE_COOKIE + '=' + nonce +
      '; Path=/; Max-Age=900; HttpOnly; SameSite=Lax';
    if (googleConfigured()) {
      return sendRedirect(res, googleAuthorizeUrl(state, origin), { 'Set-Cookie': cookie });
    }
    return sendRedirect(res, '/demo-google?state=' + encodeURIComponent(state) +
      '&redirect=' + encodeURIComponent(redirect), { 'Set-Cookie': cookie });
  }

  if (method === 'GET' && p === '/api/auth/google/callback') {
    const state = cleanStr(url.searchParams.get('state'), 100);
    const rec = takeOauthState(state);
    if (!rec) throw new ApiError(400, 'That sign-in link expired. Please start again.');
    // Existence alone proves nothing: the browser finishing the sign-in has to
    // be the one that started it, or a crafted link could sign this person
    // into an account that is not theirs.
    const nonce = readCookie(req, OAUTH_NONCE_COOKIE);
    if (!rec.nonce || !nonce || !safeTokenEqual(nonce, rec.nonce)) {
      throw new ApiError(400, 'That sign-in did not start in this browser. Please try again from the booking page.');
    }
    if (url.searchParams.get('error')) {
      throw new ApiError(401, 'Google sign-in was cancelled. You can try again or use your email.');
    }
    let profile;
    if (googleConfigured()) {
      const code = cleanStr(url.searchParams.get('code'), 500);
      if (!code) throw new ApiError(400, 'Google did not send a sign-in code. Please try again.');
      profile = await googleProfileFromCode(code, origin);
    } else {
      // Demo stand-in for the code exchange: the chooser page posts the picked
      // address back here. Disabled the moment real credentials exist.
      const email = cleanStr(url.searchParams.get('demo_email'), 200).toLowerCase();
      if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address');
      // Nothing here verifies the address the way Google would, so this path
      // must never hand out the owner account. Without this, anyone who can
      // reach the demo could type her address and land in the dashboard.
      if (ADMIN_EMAILS.includes(email)) {
        throw new ApiError(403,
          'The demo sign-in cannot be used for the owner account. Sign in with an email code instead.');
      }
      profile = { email, name: cleanStr(url.searchParams.get('demo_name'), 100) || null };
    }
    const client = upsertGoogleClient(profile.email, profile.name);
    const token = startSession(client, 'google');
    save();
    return sendRedirect(res, rec.redirect + '#sp_token=' + token, {
      'Set-Cookie': OAUTH_NONCE_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
    });
  }

  /* -- auth: email code -- */
  if (method === 'POST' && p === '/api/auth/request-code') {
    const body = await readBody(req);
    const email = cleanStr(body.email, 200).toLowerCase();
    if (!isEmail(email)) throw new ApiError(400, 'Enter a valid email address');
    const ip = clientIp(req);
    if (rateLimitHit('ip:' + ip) || rateLimitHit('email:' + email)) {
      throw new ApiError(429, 'Too many code requests. Please wait about 15 minutes and try again.');
    }
    // purpose only changes the wording of the message. Same code, same rules.
    const purpose = cleanStr(body.purpose, 20).toLowerCase() === 'reset' ? 'reset' : 'login';
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.codes[email] = { hash: hashCode(code), expires: Date.now() + CODE_TTL_MS, attempts: 0 };
    const existing = findClientByEmail(email);
    notify(purpose === 'reset' ? 'reset_code' : 'login_code',
      { email, phone: existing && existing.phone, name: existing && existing.name },
      { code });
    save();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/auth/verify') {
    const body = await readBody(req);
    const email = cleanStr(body.email, 200).toLowerCase();
    const code = cleanStr(body.code, 10);
    const rec = db.codes[email];
    if (!rec || rec.expires < Date.now()) throw new ApiError(400, 'Code expired. Request a new one.');
    rec.attempts += 1;
    if (rec.attempts > CODE_MAX_ATTEMPTS) {
      delete db.codes[email];
      save();
      throw new ApiError(429, 'Too many attempts. Request a new code.');
    }
    if (hashCode(code) !== rec.hash) { save(); throw new ApiError(400, 'That code is not right. Try again.'); }
    delete db.codes[email];
    let client = findClientByEmail(email);
    if (!client) client = makeClient(email, null, null, ADMIN_EMAILS.includes(email));
    // Code sign-in never touches an existing password.
    const token = startSession(client, 'code');
    save();
    return sendJson(res, 200, { token, client: publicClient(client) });
  }

  if (method === 'GET' && p === '/api/me') {
    const client = requireAuth(req);
    const mine = db.bookings
      .filter((b) => b.client_id === client.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    // Awaiting-deposit bookings carry a checkout_url so the client can finish
    // paying later. Regenerate the checkout session if it is missing or stale.
    const bookings = [];
    let dirty = false;
    for (const b of mine) {
      if (b.status !== 'awaiting_deposit' || b.deposit_cents == null) { bookings.push(b); continue; }
      let sess = b.checkout_session_id ? db.checkout_sessions[b.checkout_session_id] : null;
      if (!sess || !sess.url || sess.paid) {
        if (sess) delete db.checkout_sessions[sess.id];
        const fresh = await createCheckout(b, origin);
        b.checkout_session_id = fresh.id;
        sess = db.checkout_sessions[fresh.id];
        dirty = true;
      }
      bookings.push({ ...b, checkout_url: sess.url });
    }
    if (dirty) save();
    return sendJson(res, 200, {
      client: publicClient(client),
      bookings: bookings.map(withMoney)
    });
  }

  if (method === 'POST' && p === '/api/me') {
    const client = requireAuth(req);
    const body = await readBody(req);
    if (body.name !== undefined) client.name = cleanStr(body.name, 100) || null;
    if (body.phone !== undefined) client.phone = cleanStr(body.phone, 30) || null;
    for (const b of db.bookings) {
      if (b.client_id === client.id && b.status !== 'canceled' && b.status !== 'completed') {
        b.client_name = client.name;
        b.client_phone = client.phone;
      }
    }
    save();
    return sendJson(res, 200, { client: publicClient(client) });
  }

  /* -- services and availability -- */
  if (method === 'GET' && p === '/api/services') {
    return sendJson(res, 200, { categories: catalog.categories });
  }

  if (method === 'GET' && p === '/api/availability') {
    const serviceId = url.searchParams.get('service_id') || '';
    const date = url.searchParams.get('date') || '';
    const svc = catalog.byId.get(serviceId);
    if (!svc) throw new ApiError(404, 'Unknown service');
    if (!isValidDate(date)) throw new ApiError(400, 'Date must be YYYY-MM-DD');
    return sendJson(res, 200, availability(svc, date));
  }

  /* -- bookings (client) -- */
  if (method === 'POST' && p === '/api/bookings') {
    const client = requireAuth(req);
    const body = await readBody(req);
    const svc = catalog.byId.get(cleanStr(body.service_id, 120));
    if (!svc) throw new ApiError(404, 'Unknown service');
    const date = cleanStr(body.date, 10);
    const time = cleanStr(body.time, 5);
    if (!isValidDate(date)) throw new ApiError(400, 'Date must be YYYY-MM-DD');
    if (Number.isNaN(toMin(time))) throw new ApiError(400, 'Time must be HH:MM');
    const av = availability(svc, date);
    if (av.closed) throw new ApiError(409, 'Sitting Pretty is closed that day');
    if (av.blocked) throw new ApiError(409, 'That day is not available');
    if (!av.slots.includes(time)) throw new ApiError(409, 'That time is no longer available');

    const booking = {
      id: nextId('bk'),
      client_id: client.id, client_name: client.name,
      client_email: client.email, client_phone: client.phone,
      service_id: svc.service_id, service_name: svc.name,
      price: svc.price, deposit_cents: svc.deposit_cents,
      date, time, duration_min: svc.duration_min || 30,
      status: svc.deposit_cents == null ? 'request' : 'awaiting_deposit',
      notes: cleanStr(body.notes, 500),
      created_at: new Date().toISOString()
    };

    // Claim the slot NOW, in the same synchronous turn as the availability
    // check above. Creating the checkout session is async, and doing it first
    // yielded the event loop between "is this free?" and "it is mine", which
    // let two people booking at the same moment both win the same time.
    db.bookings.push(booking);

    let checkoutUrl = null;
    if (svc.deposit_cents == null) {
      notify('booking_request_received',
        { email: client.email, phone: client.phone, name: client.name },
        { booking });
    } else {
      let session;
      try {
        session = await createCheckout(booking, origin);
      } catch (err) {
        // Never leave a slot held by a booking that has no way to be paid.
        const i = db.bookings.indexOf(booking);
        if (i >= 0) db.bookings.splice(i, 1);
        save();
        throw err;
      }
      booking.checkout_session_id = session.id;
      checkoutUrl = session.url;
      const absolute = checkoutUrl.startsWith('http') ? checkoutUrl : origin + checkoutUrl;
      notify('booking_created_awaiting_deposit',
        { email: client.email, phone: client.phone, name: client.name },
        { booking, checkout_url: absolute });
    }
    save();
    return sendJson(res, 200, { booking, checkout_url: checkoutUrl });
  }

  if (method === 'POST' && (m = /^\/api\/bookings\/([\w-]+)\/cancel$/.exec(p))) {
    const client = requireAuth(req);
    const booking = db.bookings.find((b) => b.id === m[1]);
    if (!booking) throw new ApiError(404, 'Booking not found');
    if (booking.client_id !== client.id && !client.is_admin) throw new ApiError(403, 'Not your booking');
    if (booking.status !== 'canceled') {
      const asAdmin = client.is_admin && booking.client_id !== client.id;
      booking.status = 'canceled';
      booking.canceled_by = asAdmin ? 'admin' : 'client';
      const target = { email: booking.client_email, phone: booking.client_phone, name: booking.client_name };
      if (asAdmin) {
        notify('booking_canceled_by_admin', target, { booking });
      } else {
        notify('booking_canceled_by_client', target, { booking });
        notify('booking_canceled_admin_copy', { email: ADMIN_EMAILS[0] }, { booking, client_email: booking.client_email });
      }
      save();
    }
    return sendJson(res, 200, { booking });
  }

  /* -- payments -- */
  if (method === 'GET' && (m = /^\/api\/checkout\/([\w-]+)$/.exec(p))) {
    const session = db.checkout_sessions[m[1]];
    if (!session) throw new ApiError(404, 'Unknown checkout session');
    const booking = db.bookings.find((b) => b.id === session.booking_id);
    if (!booking) throw new ApiError(404, 'Booking not found');
    requireCheckoutAccess(req, url, session, booking);
    return sendJson(res, 200, {
      booking,
      amount_cents: session.amount_cents,
      service_name: booking.service_name,
      payable: isPayable(booking) && !session.paid,
      already_paid: !!session.paid,
    });
  }

  if (method === 'POST' && (m = /^\/api\/checkout\/([\w-]+)\/pay$/.exec(p))) {
    // DEMO ONLY simulated payment success.
    const session = db.checkout_sessions[m[1]];
    if (!session) throw new ApiError(404, 'Unknown checkout session');
    const booking = db.bookings.find((b) => b.id === session.booking_id);
    if (!booking) throw new ApiError(404, 'Booking not found');
    requireCheckoutAccess(req, url, session, booking);
    if (session.paid) return sendJson(res, 200, { ok: true, booking, already_paid: true });
    // Never take money for an appointment that is no longer standing.
    if (booking.status === 'canceled') {
      throw new ApiError(409,
        'This appointment was cancelled, so it can no longer be paid for. Text Ebony if you would like to rebook.');
    }
    if (session.kind === 'balance') {
      if (booking.paid_in_full) throw new ApiError(409, 'This one is already paid in full.');
      session.paid = true;
      markBalancePaid(booking, session.amount_cents);
    } else {
      if (!isPayable(booking)) {
        throw new ApiError(409, 'This appointment is already settled, so there is nothing left to pay.');
      }
      session.paid = true;
      markDepositPaid(booking, session.amount_cents);
    }
    save();
    return sendJson(res, 200, { ok: true, booking });
  }

  // The client chose to settle the rest online instead of in person.
  if (method === 'POST' && (m = /^\/api\/bookings\/([\w-]+)\/pay-balance$/.exec(p))) {
    const client = requireAuth(req);
    const booking = db.bookings.find((b) => b.id === m[1]);
    if (!booking) throw new ApiError(404, 'Booking not found');
    if (booking.client_id !== client.id && !client.is_admin) throw new ApiError(403, 'Not your booking');
    if (booking.status === 'canceled') throw new ApiError(409, 'That appointment was cancelled.');
    if (booking.status === 'awaiting_deposit') {
      throw new ApiError(409, 'Pay the deposit first, then the rest can be paid any time.');
    }
    if (booking.paid_in_full) throw new ApiError(409, 'This one is already paid in full.');
    const balance = balanceCentsFor(booking);
    if (balance == null) {
      throw new ApiError(409,
        'The final amount for this service depends on your hair, so Ebony settles it with you in person.');
    }
    const session = await createCheckout(booking, origin, 'balance', balance);
    booking.balance_session_id = session.id;
    save();
    const absolute = session.url.startsWith('http') ? session.url : origin + session.url;
    return sendJson(res, 200, { checkout_url: absolute, amount_cents: balance });
  }

  if (method === 'POST' && p === '/api/stripe/webhook') {
    // DEMO: signature is NOT verified. Production must verify
    // Stripe-Signature with the webhook signing secret before trusting this.
    const event = await readBody(req);
    if (event && event.type === 'checkout.session.completed') {
      const obj = (event.data && event.data.object) || {};
      const bookingId = (obj.metadata && obj.metadata.booking_id) ||
        (db.checkout_sessions[obj.id] && db.checkout_sessions[obj.id].booking_id);
      const booking = db.bookings.find((b) => b.id === bookingId);
      if (booking) {
        if (obj.id && db.checkout_sessions[obj.id]) db.checkout_sessions[obj.id].paid = true;
        if (isPayable(booking)) {
          markDepositPaid(booking);
        } else {
          // Money moved for an appointment that is no longer standing. Do not
          // silently swallow it: flag it so Ebony can refund the client.
          notify('payment_needs_refund',
            { email: ADMIN_EMAILS[0], phone: null, name: 'Ke’Ebonie' },
            { booking });
        }
        save();
      }
    }
    return sendJson(res, 200, { received: true });
  }

  /* -- admin -- */
  if (method === 'GET' && p === '/api/admin/bookings') {
    requireAdmin(req);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const status = url.searchParams.get('status');
    let list = db.bookings.slice();
    if (from) list = list.filter((b) => b.date >= from);
    if (to) list = list.filter((b) => b.date <= to);
    if (status) list = list.filter((b) => b.status === status);
    list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return sendJson(res, 200, { bookings: list.map(withMoney) });
  }

  // Ebony settled up with the client in the chair: cash, Zelle, card, whatever.
  if (method === 'POST' && (m = /^\/api\/admin\/bookings\/([\w-]+)\/mark-paid$/.exec(p))) {
    requireAdmin(req);
    const body = await readBody(req);
    const booking = db.bookings.find((b) => b.id === m[1]);
    if (!booking) throw new ApiError(404, 'Booking not found');
    if (booking.status === 'canceled') throw new ApiError(409, 'That appointment was cancelled.');
    // She can name the amount for the services whose final price depends on
    // the hair; otherwise it settles the known balance.
    const amount = Number.isFinite(body.amount_cents) && body.amount_cents > 0
      ? Math.round(body.amount_cents)
      : balanceCentsFor(booking);
    applyPayment(booking, amount || 0);
    booking.paid_in_full = true;
    booking.paid_in_person = true;
    if (booking.status === 'awaiting_deposit' || booking.status === 'request') booking.status = 'confirmed';
    save();
    return sendJson(res, 200, { booking: withMoney(booking) });
  }

  if (method === 'POST' && (m = /^\/api\/admin\/bookings\/([\w-]+)\/status$/.exec(p))) {
    requireAdmin(req);
    const body = await readBody(req);
    const status = cleanStr(body.status, 20);
    if (!['confirmed', 'completed', 'canceled'].includes(status)) {
      throw new ApiError(400, 'Status must be confirmed, completed, or canceled');
    }
    const booking = db.bookings.find((b) => b.id === m[1]);
    if (!booking) throw new ApiError(404, 'Booking not found');
    const prev = booking.status;
    booking.status = status;
    const target = { email: booking.client_email, phone: booking.client_phone, name: booking.client_name };
    if (status === 'canceled' && prev !== 'canceled') {
      booking.canceled_by = 'admin';
      notify('booking_canceled_by_admin', target, { booking });
    } else if (status === 'confirmed' && (prev === 'awaiting_deposit' || prev === 'request')) {
      notify('booking_confirmed', target, { booking });
    }
    save();
    return sendJson(res, 200, { booking });
  }

  if (method === 'GET' && p === '/api/admin/blocked-days') {
    requireAdmin(req);
    return sendJson(res, 200, { days: db.blocked_days.slice().sort((a, b) => a.date.localeCompare(b.date)) });
  }

  if (method === 'POST' && p === '/api/admin/blocked-days') {
    requireAdmin(req);
    const body = await readBody(req);
    const date = cleanStr(body.date, 10);
    if (!isValidDate(date)) throw new ApiError(400, 'Date must be YYYY-MM-DD');
    const reason = cleanStr(body.reason, 200);
    const existing = db.blocked_days.find((d) => d.date === date);
    if (existing) existing.reason = reason;
    else db.blocked_days.push({ date, reason });
    save();
    return sendJson(res, 200, { days: db.blocked_days.slice().sort((a, b) => a.date.localeCompare(b.date)) });
  }

  if (method === 'DELETE' && (m = /^\/api\/admin\/blocked-days\/(\d{4}-\d{2}-\d{2})$/.exec(p))) {
    requireAdmin(req);
    db.blocked_days = db.blocked_days.filter((d) => d.date !== m[1]);
    save();
    return sendJson(res, 200, { days: db.blocked_days.slice().sort((a, b) => a.date.localeCompare(b.date)) });
  }

  if (method === 'GET' && p === '/api/admin/clients') {
    requireAdmin(req);
    const clients = db.clients.filter((c) => !c.is_admin).map((c) => {
      const theirs = db.bookings.filter((b) => b.client_id === c.id);
      const last = theirs.map((b) => b.date).sort().pop() || null;
      return { id: c.id, email: c.email, name: c.name, phone: c.phone, bookings_count: theirs.length, last_booking: last };
    });
    return sendJson(res, 200, { clients });
  }

  if (method === 'POST' && p === '/api/admin/broadcast') {
    requireAdmin(req);
    const body = await readBody(req);
    const subject = cleanStr(body.subject, 200);
    const message = cleanStr(body.message, 2000);
    if (!subject || !message) throw new ApiError(400, 'Subject and message are both required');
    let sent = 0;
    for (const c of db.clients) {
      if (c.is_admin) continue;
      notify('broadcast', { email: c.email, phone: c.phone, name: c.name }, { subject, message });
      sent += 1;
    }
    db.broadcasts.push({ ts: new Date().toISOString(), subject, message, sent });
    save();
    return sendJson(res, 200, { sent });
  }

  /* -- demo helpers (hidden when DEMO=0) -- */
  if (DEMO && method === 'GET' && p === '/api/_outbox') {
    return sendJson(res, 200, { messages: db.outbox });
  }

  if (DEMO && method === 'POST' && p === '/api/_reset') {
    seedDemo();
    rateBuckets.clear(); // demo resets also clear rate-limit counters
    saveNow();
    return sendJson(res, 200, { ok: true });
  }

  throw new ApiError(404, 'Not found');
}

/* ---------------- demo checkout page ------------------------------------------ */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function niceDateHuman(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function niceTimeHuman(t) {
  const mins = toMin(t);
  if (Number.isNaN(mins)) return t;
  let h = Math.floor(mins / 60);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(mins % 60).padStart(2, '0') + ' ' + ap;
}

function moneyStr(cents) {
  return cents % 100 === 0 ? '$' + cents / 100 : '$' + (cents / 100).toFixed(2);
}

// Colors approximate css/tokens.css: warm ivory bg, plum-cocoa ink, rose CTA.
const CHECKOUT_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,'Segoe UI',sans-serif;background:#faf7f4;color:#43323d;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fffdfb;border:1px solid #eadfdb;border-radius:18px;max-width:420px;width:100%;
    padding:32px 28px;box-shadow:0 10px 32px rgba(90,60,80,.12)}
  .brand{font-family:Georgia,serif;font-style:italic;font-size:1.5rem;color:#43323d;margin-bottom:18px}
  .banner{background:#fbf0dc;color:#7a5b1e;font-weight:700;font-size:.85rem;letter-spacing:.02em;
    border-radius:10px;padding:10px 14px;margin-bottom:22px;text-align:center}
  .row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #f1e8e4;font-size:.95rem}
  .row:last-of-type{border-bottom:none}
  .label{color:#7a6570}
  .val{font-weight:600;text-align:right}
  .amount{font-size:2rem;font-weight:700;color:#b34d6d;text-align:center;margin:20px 0 6px}
  .amount-note{color:#7a6570;font-size:.85rem;text-align:center;margin-bottom:22px}
  .pay{display:block;width:100%;background:#b34d6d;color:#fff;border:none;border-radius:99px;
    padding:15px 24px;font-size:1.05rem;font-weight:700;cursor:pointer;min-height:48px}
  .pay:hover{background:#9c3a5c}
  .pay[disabled]{opacity:.5;cursor:default}
  .back{display:block;text-align:center;margin-top:16px;color:#7a6570;font-size:.9rem;text-decoration:none}
  .back:hover{color:#b34d6d}
`;

function demoCheckoutPage(res, reqUrl) {
  const sessionId = reqUrl.searchParams.get('session') || '';
  const payToken = reqUrl.searchParams.get('pay_token') || '';
  const safeId = /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
  const safeToken = /^[A-Za-z0-9_-]+$/.test(payToken) ? payToken : '';
  const session = safeId && db.checkout_sessions[safeId];
  const authorized = session && session.pay_token && safeToken &&
    safeTokenEqual(safeToken, session.pay_token);
  const booking = authorized && db.bookings.find((b) => b.id === session.booking_id);

  let inner;
  if (!session || !authorized || !booking) {
    inner = `
      <div class="banner">DEMO MODE - no real charge</div>
      <p style="text-align:center;padding:12px 0 4px">This checkout link is no longer valid.</p>
      <a class="back" href="/">Back to Sitting Pretty</a>`;
  } else {
    inner = `
      <div class="banner">DEMO MODE - no real charge</div>
      <div class="row"><span class="label">Service</span><span class="val">${escapeHtml(booking.service_name)}</span></div>
      <div class="row"><span class="label">Date</span><span class="val">${escapeHtml(niceDateHuman(booking.date))}</span></div>
      <div class="row"><span class="label">Time</span><span class="val">${escapeHtml(niceTimeHuman(booking.time))}</span></div>
      <div class="row"><span class="label">Service price</span><span class="val">${escapeHtml(booking.price)}</span></div>
      <div class="amount">${escapeHtml(moneyStr(session.amount_cents))}</div>
      <div class="amount-note">${session.kind === 'balance'
        ? 'The rest of your service price. Once this clears there is nothing due at your appointment.'
        : 'Deposit due now. It holds this time for you and comes off your balance the day of your service.'}</div>
      <button class="pay" id="pay">Pay ${escapeHtml(moneyStr(session.amount_cents))}${session.kind === 'balance' ? ' balance' : ' deposit'}</button>
      <a class="back" href="/">Cancel and go back</a>
      <script>
        document.getElementById('pay').addEventListener('click', async function () {
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Processing...';
          try {
            var r = await fetch('/api/checkout/${safeId}/pay?pay_token=${safeToken}', { method: 'POST' });
            if (!r.ok) throw new Error('pay failed');
            window.location.href = '/?paid=1&booking=${escapeHtml(booking.id)}';
          } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Pay deposit';
            alert('Something went wrong. Please try again.');
          }
        });
      </script>`;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Deposit checkout | Sitting Pretty</title>
<style>${CHECKOUT_CSS}</style>
</head>
<body>
  <div class="card">
    <div class="brand">Sitting Pretty</div>
    ${inner}
  </div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/* ---------------- demo google account chooser ---------------------------------- */

// Stand-in for Google's consent screen while there are no Google credentials.
// It is clearly labelled as a demo, and it is switched off automatically the
// moment GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
const DEMO_GOOGLE_ACCOUNTS = [
  { name: 'Ariel Monroe', email: 'ariel.monroe@demo.gmail.com', initial: 'A' },
  { name: 'Jordan Pike', email: 'jordan.pike@demo.gmail.com', initial: 'J' },
  { name: 'Tasha Reeves', email: 'tasha@demo.local', initial: 'T', note: 'already a Sitting Pretty client' }
];

// Pulls the shared tokens so this page moves with the rest of the site.
const GOOGLE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--font-body);background:var(--bg);color:var(--ink);font-weight:500;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.6}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);
    max-width:440px;width:100%;padding:28px 24px;box-shadow:var(--shadow-lift)}
  .brand{font-family:var(--font-script);font-size:1.5rem;color:var(--rose);margin-bottom:14px}
  .banner{background:var(--rose-soft);color:var(--rose-deep);font-weight:700;font-size:.8rem;
    letter-spacing:.04em;text-transform:uppercase;border-radius:var(--r-pill);
    padding:9px 14px;margin-bottom:20px;text-align:center}
  h1{font-size:1.25rem;font-weight:900;line-height:1.25;margin-bottom:6px}
  .sub{color:var(--ink-dim);font-size:.92rem;margin-bottom:20px}
  .acct{display:flex;align-items:center;gap:12px;width:100%;text-align:left;text-decoration:none;
    background:transparent;border:1px solid var(--line);border-radius:var(--r-card);
    padding:12px 14px;margin-bottom:10px;color:var(--ink);cursor:pointer;
    transition:border-color .2s var(--ease-out), background .2s var(--ease-out)}
  .acct:hover{border-color:var(--rose);background:var(--surface-2)}
  .avatar{width:40px;height:40px;border-radius:50%;background:var(--rose-soft);color:var(--rose-deep);
    display:flex;align-items:center;justify-content:center;font-weight:900;flex:0 0 auto}
  .acct .who{font-weight:700;font-size:.98rem}
  .acct .addr{color:var(--ink-dim);font-size:.85rem;word-break:break-all}
  .acct .note{color:var(--rose-deep);font-size:.78rem;font-weight:700}
  .divider{display:flex;align-items:center;gap:12px;color:var(--ink-faint);font-size:.8rem;
    margin:18px 0 14px}
  .divider::before,.divider::after{content:"";height:1px;background:var(--line);flex:1}
  label{display:block;font-size:.85rem;font-weight:700;color:var(--ink-dim);margin-bottom:6px}
  input{width:100%;font-family:var(--font-body);font-size:1rem;color:var(--ink);
    background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r-pill);
    padding:12px 16px;min-height:48px;margin-bottom:12px}
  input:focus{outline:2px solid var(--rose);outline-offset:1px}
  .btn-solid{width:100%}
  .back{display:block;text-align:center;margin-top:16px;color:var(--ink-dim);font-size:.9rem;
    text-decoration:none}
  .back:hover{color:var(--rose)}
  .foot{color:var(--ink-faint);font-size:.78rem;text-align:center;margin-top:14px}
`;

function demoGooglePage(res, reqUrl) {
  const state = cleanStr(reqUrl.searchParams.get('state'), 100);
  const valid = /^[a-f0-9]{16,100}$/.test(state) && peekOauthState(state);

  let inner;
  if (googleConfigured()) {
    inner = `
      <h1>Google is live on this server</h1>
      <p class="sub">Real Google credentials are set, so this demo chooser is turned off.
      Start again from the Sitting Pretty sign-in screen.</p>
      <a class="back" href="/">Back to Sitting Pretty</a>`;
  } else if (!valid) {
    inner = `
      <h1>This sign-in link expired</h1>
      <p class="sub">Sign-in links are good for 10 minutes. Please start again from the
      Sitting Pretty sign-in screen.</p>
      <a class="back" href="/">Back to Sitting Pretty</a>`;
  } else {
    const s = encodeURIComponent(state);
    const rows = DEMO_GOOGLE_ACCOUNTS.map((a) => `
      <a class="acct" href="/api/auth/google/callback?state=${s}&demo_email=${encodeURIComponent(a.email)}&demo_name=${encodeURIComponent(a.name)}">
        <span class="avatar">${escapeHtml(a.initial)}</span>
        <span>
          <span class="who">${escapeHtml(a.name)}</span><br>
          <span class="addr">${escapeHtml(a.email)}</span>
          ${a.note ? '<br><span class="note">' + escapeHtml(a.note) + '</span>' : ''}
        </span>
      </a>`).join('');
    inner = `
      <h1>Choose an account</h1>
      <p class="sub">This is a practice version of the Google sign-in screen. These accounts
      are made up for the demo, and no Google account is contacted.</p>
      ${rows}
      <div class="divider">or use another email</div>
      <form method="GET" action="/api/auth/google/callback">
        <input type="hidden" name="state" value="${escapeHtml(state)}">
        <label for="demo_email">Email address</label>
        <input id="demo_email" name="demo_email" type="email" required
          placeholder="you@example.com" autocomplete="email">
        <button class="btn btn-solid" type="submit">Continue</button>
      </form>
      <a class="back" href="/">Back to Sitting Pretty</a>
      <p class="foot">When Ke'Ebonie is ready, real Google credentials replace this page
      and nothing else changes.</p>`;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Demo Google sign-in | Sitting Pretty</title>
<link rel="preconnect" href="https://api.fontshare.com">
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@500,700,900&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Playball&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/tokens.css">
<style>${GOOGLE_CSS}</style>
</head>
<body>
  <div class="card">
    <div class="brand">Sitting Pretty</div>
    <div class="banner">Demo sign-in, not real Google</div>
    ${inner}
  </div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/* ---------------- static files ------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf'
};

// Directories that must never be served (db.json holds tokens and client PII).
// Compared per path segment, lowercased, so case-insensitive filesystems
// (macOS APFS: /Server/ === /server/) cannot bypass the guard.
const PRIVATE_DIRS = new Set(['server', 'supabase', '.git', 'node_modules']);
const REALPATH = fs.realpathSync.native || fs.realpathSync;
const REAL_ROOT = REALPATH(ROOT);

// Resolve a requested pathname to a real on-disk file that is inside the
// project root and not inside any private directory. Returns null otherwise.
function resolveStaticPath(pathname) {
  if (pathname.includes('\0')) return null;
  let real;
  try {
    // realpath resolves symlinks and, on macOS, canonicalizes case.
    real = REALPATH(path.resolve(ROOT, '.' + pathname));
  } catch {
    return null; // does not exist
  }
  const rel = path.relative(REAL_ROOT, real);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return null; // outside the project root (or the root itself)
  }
  for (const seg of rel.split(path.sep)) {
    if (seg.startsWith('.')) return null;          // dotfiles and dot-dirs
    if (PRIVATE_DIRS.has(seg.toLowerCase())) return null;
  }
  return real;
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Content-Length': stat.size };
  if (ext === '.html') headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

/* ---------------- http server -------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad request');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, HEAD, POST, DELETE, OPTIONS' });
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname === '/demo-checkout' && (req.method === 'GET' || req.method === 'HEAD')) {
      return demoCheckoutPage(res, url);
    }
    if (url.pathname === '/demo-google' && (req.method === 'GET' || req.method === 'HEAD')) {
      return demoGooglePage(res, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, url);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : 'Server error';
    if (status === 500) console.error('[server]', req.method, url.pathname, err);
    const extra = (err instanceof ApiError && err.extra) || null;
    if (!res.headersSent) sendJson(res, status, { error: message, ...(extra || {}) });
    else res.end();
  }
});

loadDb();
sweepExpiredDeposits();
sweepExpiredSessions();
const sweepTimer = setInterval(() => {
  sweepExpiredDeposits();
  sweepExpiredSessions();
}, SWEEP_INTERVAL_MS);
if (sweepTimer.unref) sweepTimer.unref();

// Local demo: loopback only, never exposed to the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log('Sitting Pretty demo server (127.0.0.1 only)');
  console.log('  Site:      http://localhost:' + PORT + '/');
  console.log('  Dashboard: http://localhost:' + PORT + '/dashboard.html');
  if (DEMO) console.log('  Outbox:    http://localhost:' + PORT + '/api/_outbox (login codes land here)');
  else console.log('  Demo helpers: OFF (DEMO=0)');
  console.log('  Admin:     ' + ADMIN_EMAILS.join(', '));
  console.log('  Payments:  ' + (STRIPE_KEY ? 'Stripe (real Checkout sessions)' : 'demo mode (/demo-checkout)'));
  console.log('  Google:    ' + (googleConfigured()
    ? 'real OAuth (GOOGLE_CLIENT_ID set)'
    : 'demo chooser (/demo-google)'));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  });
}
