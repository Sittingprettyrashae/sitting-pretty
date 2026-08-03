// Sitting Pretty local demo server.
// Pure Node >= 20, zero npm dependencies. Serves the static site AND the /api/*
// contract from API.md on the same origin. JSON persistence in server/db.json.
// Run: node server/server.mjs   (env: PORT, ADMIN_EMAILS, STRIPE_SECRET_KEY)

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
    clients: [], bookings: [], sessions: {}, codes: {},
    checkout_sessions: {}, blocked_days: [], outbox: [], broadcasts: [],
    seq: {}
  };
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
  } catch {
    seedDemo();
    saveNow();
    console.log('[db] seeded fresh demo data at', DB_PATH);
  }
}

/* ---------------- demo seed ------------------------------------------------- */

function makeClient(email, name, phone, isAdmin) {
  const c = {
    id: nextId('cl'), email, name: name || null, phone: phone || null,
    is_admin: !!isAdmin, created_at: new Date().toISOString()
  };
  db.clients.push(c);
  return c;
}

function seedDemo() {
  db = defaultDb();
  const admin = makeClient('ebony@demo.local', "Ke'Ebonie Hill", '(817) 704-8300', true);
  const maya = makeClient('maya@demo.local', 'Maya Johnson', '(817) 555-0141', false);
  const tasha = makeClient('tasha@demo.local', 'Tasha Reeves', '(682) 555-0163', false);
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

/* ---------------- clients, auth, sessions ----------------------------------- */

function publicClient(c) {
  return { id: c.id, email: c.email, name: c.name, phone: c.phone, is_admin: !!c.is_admin };
}

function findClientByEmail(email) {
  return db.clients.find((c) => c.email === email) || null;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function authClient(req) {
  const m = /^Bearer\s+([A-Za-z0-9]{16,64})$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const sess = db.sessions[m[1]];
  if (!sess) return null;
  return db.clients.find((c) => c.id === sess.client_id) || null;
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

function rateLimitHit(key) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  const limited = hits.length >= RATE_MAX_REQUESTS;
  if (!limited) hits.push(now);
  if (hits.length) rateBuckets.set(key, hits);
  else rateBuckets.delete(key);
  return limited;
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

async function createCheckout(booking, origin) {
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
    p.set('line_items[0][price_data][unit_amount]', String(booking.deposit_cents));
    p.set('line_items[0][price_data][product_data][name]', 'Deposit: ' + booking.service_name);
    p.set('metadata[booking_id]', booking.id);
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
      id: json.id, booking_id: booking.id, amount_cents: booking.deposit_cents,
      paid: false, stripe: true, url: json.url, pay_token: payToken,
      created_at: new Date().toISOString()
    };
    return { id: json.id, url: json.url };
  }
  const sid = 'demo_' + crypto.randomBytes(8).toString('hex');
  const url = '/demo-checkout?session=' + sid + '&pay_token=' + payToken;
  db.checkout_sessions[sid] = {
    id: sid, booking_id: booking.id, amount_cents: booking.deposit_cents,
    paid: false, stripe: false, url, pay_token: payToken,
    created_at: new Date().toISOString()
  };
  return { id: sid, url };
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

function markDepositPaid(booking) {
  if (booking.status === 'awaiting_deposit' || booking.status === 'request') {
    booking.status = 'confirmed';
    notify('booking_confirmed',
      { email: booking.client_email, phone: booking.client_phone, name: booking.client_name },
      { booking });
    save();
  }
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

  /* -- auth -- */
  if (method === 'POST' && p === '/api/auth/request-code') {
    const body = await readBody(req);
    const email = cleanStr(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address');
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimitHit('ip:' + ip) || rateLimitHit('email:' + email)) {
      throw new ApiError(429, 'Too many code requests. Please wait about 15 minutes and try again.');
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.codes[email] = { hash: hashCode(code), expires: Date.now() + CODE_TTL_MS, attempts: 0 };
    const existing = findClientByEmail(email);
    notify('login_code',
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
    client.is_admin = ADMIN_EMAILS.includes(email);
    const token = crypto.randomBytes(16).toString('hex');
    db.sessions[token] = { client_id: client.id, created_at: new Date().toISOString() };
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
    return sendJson(res, 200, { client: publicClient(client), bookings });
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

    let checkoutUrl = null;
    if (svc.deposit_cents == null) {
      db.bookings.push(booking);
      notify('booking_request_received',
        { email: client.email, phone: client.phone, name: client.name },
        { booking });
    } else {
      const session = await createCheckout(booking, origin);
      booking.checkout_session_id = session.id;
      db.bookings.push(booking);
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
    return sendJson(res, 200, { booking, amount_cents: session.amount_cents, service_name: booking.service_name });
  }

  if (method === 'POST' && (m = /^\/api\/checkout\/([\w-]+)\/pay$/.exec(p))) {
    // DEMO ONLY simulated payment success.
    const session = db.checkout_sessions[m[1]];
    if (!session) throw new ApiError(404, 'Unknown checkout session');
    const booking = db.bookings.find((b) => b.id === session.booking_id);
    if (!booking) throw new ApiError(404, 'Booking not found');
    requireCheckoutAccess(req, url, session, booking);
    session.paid = true;
    markDepositPaid(booking);
    save();
    return sendJson(res, 200, { ok: true, booking });
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
        markDepositPaid(booking);
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
    return sendJson(res, 200, { bookings: list });
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
      <div class="amount-note">Deposit due now. It comes off your balance the day of your service.</div>
      <button class="pay" id="pay">Pay ${escapeHtml(moneyStr(session.amount_cents))} deposit</button>
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
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, url);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : 'Server error';
    if (status === 500) console.error('[server]', req.method, url.pathname, err);
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
  }
});

loadDb();
sweepExpiredDeposits();
const sweepTimer = setInterval(sweepExpiredDeposits, SWEEP_INTERVAL_MS);
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
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  });
}
