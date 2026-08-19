// Shared API client for Sitting Pretty (public site + dashboard).
// Demo: same-origin /api (server/server.mjs). Production: set window.SP_CONFIG
// = {apiBase} in a config.js loaded before this file (see RUNBOOK.md).
//
// Three ways in, all landing on {token, client} (see API.md "Auth"):
//   password  -> SP.signup / SP.login
//   Google    -> SP.google.mount(el) (One Tap, in page, live site)
//                SP.loginWithGoogle() (redirect round trip, demo only)
//   email code-> SP.requestCode / SP.verify  (fallback + password reset)
// The token lives in localStorage under "sp_token" and sessions are long lived,
// so a returning client stays signed in and never needs a code for booking.
window.SP = (() => {
  const base = (window.SP_CONFIG && window.SP_CONFIG.apiBase) || "";
  const KEY = "sp_token";

  const getToken = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const setToken = (t) => { try { if (t) localStorage.setItem(KEY, t); } catch (e) {} };
  const clearToken = () => { try { localStorage.removeItem(KEY); } catch (e) {} };

  // ---- Google round trip: we come back at <path>#sp_token=<token> ----
  // Store it, drop the fragment so the token never sits in the address bar or
  // in a shared link, and let the page keep booting normally (no reload).
  let cameBackFromRedirect = false;
  (function absorbTokenFromHash() {
    const hash = window.location.hash || "";
    const m = /[#&]sp_token=([^&]+)/.exec(hash);
    const at = /[#&]access_token=([^&]+)/.exec(hash);
    const rt = /[#&]refresh_token=([^&]+)/.exec(hash);
    if (!m && !at) return;
    if (m) setToken(decodeURIComponent(m[1]));
    if (at) setToken(decodeURIComponent(at[1]));
    if (rt) { try { localStorage.setItem("sp_refresh", decodeURIComponent(rt[1])); } catch (e) {} }
    cameBackFromRedirect = true;
    const rest = hash
      .replace(/[#&](sp_token|access_token|refresh_token|expires_in|expires_at|token_type|provider_token|provider_refresh_token|type)=[^&]*/g, "")
      .replace(/^#?&/, "#");
    const clean = window.location.pathname + window.location.search + (rest === "#" ? "" : rest);
    try { history.replaceState(null, "", clean); }
    catch (e) { window.location.hash = ""; }
  })();

  // Plain-language errors. err.status and err.data are kept so callers can spot
  // the special cases (needs_password_setup, 409 email taken, 429 slow down).
  function apiError(status, data) {
    let message = (data && data.error) || "";
    if (!message) {
      if (status === 404 || status === 501) message = "That sign-in option is not turned on yet. Use the code option instead.";
      else if (status === 429) message = "Too many tries. Please wait a few minutes and try again.";
      else if (status >= 500) message = "The booking system is having a moment. Please try again.";
      else message = "Something went wrong (" + status + ").";
    }
    const err = new Error(message);
    err.status = status;
    err.data = data || null;
    err.needsPasswordSetup = !!(data && data.needs_password_setup);
    return err;
  }

  async function request(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const token = getToken();
    const anon = (window.SP_CONFIG && window.SP_CONFIG.supabaseAnonKey) || "";
    // Supabase puts a gateway in front of edge functions that rejects any
    // request without an Authorization header, so a visitor who has not signed
    // in yet cannot even read the price list. The anon key is designed to be
    // public and sit in a browser; row level security is what actually guards
    // the data. Send it as the floor, and the client's own token when there is
    // one. The local demo has no anon key, so nothing changes there.
    if (anon) headers.apikey = anon;
    if (token) headers.Authorization = "Bearer " + token;
    else if (anon) headers.Authorization = "Bearer " + anon;
    let body = opts.body;
    if (body != null && typeof body !== "string") body = JSON.stringify(body);
    let res;
    try {
      res = await fetch(base + path, Object.assign({}, opts, { headers, body }));
    } catch (e) {
      const err = new Error("We could not reach the booking system. Check your connection and try again.");
      err.status = 0;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      // A Supabase access token lasts about an hour. Rather than signing a
      // client out mid-booking, spend the refresh token once and retry.
      if (res.status === 401 && onSupabase && !opts.__retried && getRefresh() &&
          !/\/api\/auth\/(bootstrap|logout)/.test(path)) {
        if (await sbRefresh()) {
          return request(path, Object.assign({}, opts, { __retried: true }));
        }
      }
      if (res.status === 401 && !/\/api\/auth\//.test(path)) { clearToken(); clearRefresh(); }
      throw apiError(res.status, data);
    }
    return data;
  }

  // Every sign-in path funnels through here so the token is stored once.
  async function authRequest(path, body) {
    const data = await request(path, { method: "POST", body });
    if (data && data.token) setToken(data.token);
    return data;
  }

  // Password rules, stated to the client BEFORE they submit (API.md: min 8,
  // nothing trivial). Returns a plain sentence, or null when the password is ok.
  const PASSWORD_HINT = "At least 8 characters. Anything you will remember works.";
  const TRIVIAL = ["password", "12345678", "123456789", "qwertyui", "iloveyou", "sittingpretty", "letmein1"];
  function passwordProblem(pw) {
    const v = String(pw || "");
    if (!v) return "Enter a password.";
    if (v.length < 8) return "Passwords need at least 8 characters.";
    if (TRIVIAL.indexOf(v.toLowerCase()) !== -1) return "That password is too easy to guess. Try another one.";
    return null;
  }
  const emailLooksOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());


  // ---------------------------------------------------------------------
  // Two backends, one interface.
  //
  // The local demo server implements /api/auth/* itself. Her live site does
  // NOT: the edge function returns 410 there on purpose, because Supabase Auth
  // owns sign-in in production. Without this adapter every client hits a wall
  // at the account step on the real site while the demo looks perfect.
  //
  // No library on purpose: the rest of this site is dependency-free static
  // files, so this talks to the Supabase Auth REST API with plain fetch.
  // ---------------------------------------------------------------------
  const SB_URL = (window.SP_CONFIG && window.SP_CONFIG.supabaseUrl) || "";
  const SB_KEY = (window.SP_CONFIG && window.SP_CONFIG.supabaseAnonKey) || "";
  const onSupabase = !!(SB_URL && SB_KEY);
  const RKEY = "sp_refresh";

  const getRefresh = () => { try { return localStorage.getItem(RKEY); } catch (e) { return null; } };
  const setRefresh = (t) => { try { if (t) localStorage.setItem(RKEY, t); } catch (e) {} };
  const clearRefresh = () => { try { localStorage.removeItem(RKEY); } catch (e) {} };

  async function sbFetch(path, body, method) {
    const headers = { apikey: SB_KEY, "Content-Type": "application/json" };
    const tok = getToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    const res = await fetch(SB_URL + "/auth/v1" + path, {
      method: method || "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw sbError(res.status, data);
    return data || {};
  }

  // Supabase speaks in codes; her clients should read plain English, and the
  // wrong-password case must not reveal whether the address has an account.
  function sbError(status, data) {
    const code = (data && (data.error_code || data.code)) || "";
    const raw = (data && (data.msg || data.error_description || data.message || data.error)) || "";
    let message;
    if (code === "invalid_credentials" || /invalid login/i.test(raw)) {
      message = "That email and password do not match. Please try again.";
    } else if (code === "user_already_exists" || /already registered/i.test(raw)) {
      message = "That email already has an account. Please sign in, or use a sign-in code.";
    } else if (code === "over_email_send_rate_limit" || status === 429) {
      message = "Too many tries just now. Please wait a few minutes and try again.";
    } else if (code === "email_address_invalid" || /invalid.*email/i.test(raw)) {
      message = "That email does not look right. Check it and try again.";
    } else if (code === "weak_password") {
      message = "That password is too easy to guess. Try another one.";
    } else if (code === "otp_expired" || /expired/i.test(raw)) {
      message = "That code has expired. Ask for a new one.";
    } else if (/token|otp/i.test(code) || /invalid.*(token|code)/i.test(raw)) {
      message = "That code is not right. Check it and try again.";
    } else {
      message = raw || "Something went wrong. Please try again.";
    }
    const err = new Error(message);
    err.status = status;
    err.data = data || null;
    return err;
  }

  // A Supabase access token lasts about an hour. Her clients are promised they
  // stay signed in, so swap the refresh token for a new session rather than
  // dumping someone out in the middle of booking.
  async function sbRefresh() {
    const rt = getRefresh();
    if (!rt) return false;
    try {
      const data = await sbFetch("/token?grant_type=refresh_token", { refresh_token: rt });
      if (data && data.access_token) { storeSession(data); return true; }
    } catch (e) { /* fall through: treat as signed out */ }
    clearToken(); clearRefresh();
    return false;
  }

  function storeSession(data) {
    if (data && data.access_token) setToken(data.access_token);
    if (data && data.refresh_token) setRefresh(data.refresh_token);
  }

  // Supabase hands back a user with no session when the address still needs
  // confirming. Saying so beats a silent failure that looks like a bad password.
  function requireSession(data, whenMissing) {
    if (data && data.access_token) { storeSession(data); return data; }
    const err = new Error(whenMissing);
    err.status = 401;
    err.data = data || null;
    throw err;
  }

  // Make sure her clients row exists and carries the name and number she gave.
  async function bootstrapClient(name, phone) {
    try {
      await request("/api/auth/bootstrap", {
        method: "POST",
        body: {
          name: name ? String(name).trim() : undefined,
          phone: phone ? String(phone).trim() : undefined,
        },
      });
    } catch (e) { /* the row is created on first authenticated call anyway */ }
  }

  const sbAuth = {
    signup: async (email, password, name, phone) => {
      const data = await sbFetch("/signup", {
        email, password,
        data: { name: name || null, phone: phone || null },
      });
      requireSession(data,
        "Check your email to confirm your address, then come back and sign in.");
      await bootstrapClient(name, phone);
      return data;
    },
    login: async (email, password) => {
      const data = await sbFetch("/token?grant_type=password", { email, password });
      requireSession(data, "That email and password do not match. Please try again.");
      await bootstrapClient();
      return data;
    },
    requestCode: (email) => sbFetch("/otp", { email, create_user: true }),
    verify: async (email, code) => {
      const data = await sbFetch("/verify", { email, token: code, type: "email" });
      requireSession(data, "That code is not right. Check it and try again.");
      await bootstrapClient();
      return data;
    },
    setPassword: (password) => sbFetch("/user", { password }, "PUT"),
    loginWithGoogle: (redirectPath) => {
      const back = window.location.origin +
        (redirectPath || (window.location.pathname + window.location.search));
      window.location.href = SB_URL + "/auth/v1/authorize?provider=google&redirect_to=" +
        encodeURIComponent(back);
    },
    logout: async () => { try { await sbFetch("/logout", {}); } catch (e) {} },
  };

  // ---------------------------------------------------------------------
  // Google, the One Tap way (js/config.js googleClientId).
  //
  // The redirect flow below still exists for the local demo, but her live site
  // does not use it. Sending a client to accounts.google.com and back through
  // zfffguimcawjxtbiesqn.supabase.co means the Google prompt says
  // "zfffguimcawjxtbiesqn.supabase.co" -- which reads like a phishing page to
  // someone who came here for a hair appointment. Supabase's own fix for that
  // is a custom auth domain, which needs the Pro plan plus a paid add-on.
  //
  // Google Identity Services avoids the whole trip: Google hands the ID token
  // straight to this page, bound to the JavaScript origin, so the prompt names
  // sittingprettyrashae.com and no Supabase URL is ever shown. Supabase trades
  // that token for a normal session (grant_type=id_token), and everything
  // downstream -- sp_sync_client, the ADMIN_EMAILS reconcile, bookings -- is
  // identical to a password sign-in. It also never leaves the page, so a
  // half-finished booking survives signing in.
  // ---------------------------------------------------------------------
  const googleClientId = () => (window.SP_CONFIG && window.SP_CONFIG.googleClientId) || "";
  const googleFlagOn = () => !!(window.SP_CONFIG && window.SP_CONFIG.googleEnabled);
  // On her live site Google means One Tap, and One Tap needs a client id. The
  // demo has no client id and keeps the old redirect button.
  const usesGsi = () => onSupabase && googleFlagOn() && !!googleClientId();

  let gsiLoading = null;
  function loadGsi() {
    if (gsiLoading) return gsiLoading;
    gsiLoading = new Promise((resolve, reject) => {
      const ready = () => window.google && window.google.accounts && window.google.accounts.id;
      if (ready()) return resolve(window.google.accounts.id);
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true; s.defer = true;
      s.onload = () => ready()
        ? resolve(window.google.accounts.id)
        : reject(new Error("Google sign-in could not start. Use your email instead."));
      s.onerror = () => reject(new Error("Google sign-in could not load. Use your email instead."));
      document.head.appendChild(s);
    });
    // A failed load must not poison every later attempt.
    gsiLoading.catch(() => { gsiLoading = null; });
    return gsiLoading;
  }

  // Supabase expects the provider to have hashed the nonce (SHA-256, hex), so
  // Google gets the hash and Supabase gets the original. crypto.subtle only
  // exists in a secure context; over plain http we skip the nonce rather than
  // break sign-in, which is exactly what Supabase does when none is sent.
  async function makeNonce() {
    try {
      if (!(window.crypto && crypto.subtle && crypto.getRandomValues)) return null;
      const raw = btoa(String.fromCharCode.apply(null, Array.from(crypto.getRandomValues(new Uint8Array(32)))));
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
      const hashed = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      return { raw, hashed };
    } catch (e) { return null; }
  }

  // Google's callback is global and fires once per credential, so the most
  // recently mounted button owns the next one. Only one is ever on screen.
  let gsiPending = null;
  function gsiCallback(response) {
    const h = gsiPending;
    if (!h) return;
    if (!response || !response.credential) {
      h.onError(new Error("Google sign-in did not complete. Try again, or use your email."));
      return;
    }
    exchangeGoogleToken(response.credential, h.nonce).then(h.onSuccess, h.onError);
  }

  async function exchangeGoogleToken(credential, rawNonce) {
    const body = { provider: "google", id_token: credential };
    if (rawNonce) body.nonce = rawNonce;
    const data = await sbFetch("/token?grant_type=id_token", body);
    requireSession(data, "Google sign-in did not complete. Try again, or use your email.");
    await bootstrapClient();
    return data;
  }

  async function gsiInit(id) {
    const nonce = await makeNonce();
    id.initialize({
      client_id: googleClientId(),
      callback: gsiCallback,
      nonce: nonce ? nonce.hashed : undefined,
      ux_mode: "popup",
      auto_select: false,
      itp_support: true,
      // Chrome is removing third-party cookies; without this the prompt stops
      // appearing there. https://developers.google.com/identity/gsi/web/guides/fedcm-migration
      use_fedcm_for_prompt: true,
    });
    return nonce ? nonce.raw : null;
  }

  // Render Google's own button into `container`. Theirs, not ours, on purpose:
  // the credential only reaches us through it, and clients recognise it.
  async function googleMount(container, opts) {
    opts = opts || {};
    if (!container || !usesGsi()) return false;
    const id = await loadGsi();
    const rawNonce = await gsiInit(id);
    gsiPending = {
      nonce: rawNonce,
      onSuccess: opts.onSuccess || function () {},
      onError: opts.onError || function () {},
    };
    container.innerHTML = "";
    // Google takes a pixel width, capped at 400, and will not do percentages.
    const w = Math.max(200, Math.min(400, Math.round(container.clientWidth || 320)));
    id.renderButton(container, {
      type: "standard",
      theme: "outline",
      size: "large",
      shape: "pill",
      text: opts.text || "continue_with",
      logo_alignment: "left",
      width: w,
    });
    // renderButton fails quietly: a client id Google does not recognise leaves
    // the slot empty rather than throwing, and an empty slot above an "or"
    // divider looks like the page half-loaded. Treat drawing nothing as a
    // failure so the caller can take the whole block away.
    await new Promise((r) => setTimeout(r, 400));
    if (!container.firstElementChild) {
      throw new Error("Google sign-in is not available right now. Use your email instead.");
    }
    return true;
  }

  // The floating One Tap prompt. Deliberately NOT called anywhere yet: the
  // home page already opens the waitlist modal about 700ms in, and two
  // uninvited boxes on one page load is one too many. Wire it up if that
  // popup ever goes away.
  async function googleOneTap(opts) {
    opts = opts || {};
    if (!usesGsi() || getToken()) return false;
    const id = await loadGsi();
    const rawNonce = await gsiInit(id);
    gsiPending = {
      nonce: rawNonce,
      onSuccess: opts.onSuccess || function () {},
      onError: opts.onError || function () {},
    };
    id.prompt();
    return true;
  }

  return {
    request,
    PASSWORD_HINT,
    passwordProblem,
    emailLooksOk,
    hasToken: () => !!getToken(),
    // True when this page load arrived back from the Google round trip.
    returnedFromRedirect: () => cameBackFromRedirect,

    // Google sign-in. On her live site this is One Tap and never leaves the
    // page; the demo keeps the old redirect. Callers ask which they are on
    // rather than checking config themselves.
    google: {
      configured: () => googleFlagOn() && (!onSupabase || !!googleClientId()),
      inPage: usesGsi,
      mount: googleMount,
      oneTap: googleOneTap,
    },

    signup: (email, password, name, phone) => {
      const e = String(email || "").trim().toLowerCase();
      const p = String(password || "");
      return onSupabase
        ? sbAuth.signup(e, p, name, phone)
        : authRequest("/api/auth/signup", {
            email: e, password: p,
            name: name ? String(name).trim() : undefined,
            phone: phone ? String(phone).trim() : undefined,
          });
    },

    login: (email, password) => {
      const e = String(email || "").trim().toLowerCase();
      const p = String(password || "");
      return onSupabase
        ? sbAuth.login(e, p)
        : authRequest("/api/auth/login", { email: e, password: p });
    },

    // Full-page trip to Google and back to this same page.
    loginWithGoogle: (redirectPath) => {
      if (onSupabase) return sbAuth.loginWithGoogle(redirectPath);
      const back = redirectPath || (window.location.pathname + window.location.search);
      window.location.href = base + "/api/auth/google/start?redirect=" + encodeURIComponent(back);
    },

    requestCode: (email, purpose) => {
      const e = String(email || "").trim().toLowerCase();
      return onSupabase
        ? sbAuth.requestCode(e)
        : request("/api/auth/request-code", { method: "POST", body: { email: e, purpose: purpose || "login" } });
    },
    verify: (email, code) => {
      const e = String(email || "").trim().toLowerCase();
      const c = String(code || "").trim();
      return onSupabase ? sbAuth.verify(e, c) : authRequest("/api/auth/verify", { email: e, code: c });
    },

    // Sets or replaces the password for whoever is signed in right now. The
    // server rotates every session on a password change and hands back a fresh
    // token, so store it or the client is signed straight back out.
    setPassword: (password) => {
      const p = String(password || "");
      return onSupabase
        ? sbAuth.setPassword(p)
        : authRequest("/api/auth/set-password", { password: p });
    },

    me: () => request("/api/me"),
    updateMe: (fields) => request("/api/me", { method: "POST", body: fields }),

    // Tell the server to drop the session, then forget it locally either way.
    logout: async () => {
      if (getToken()) {
        if (onSupabase) await sbAuth.logout();
        else { try { await request("/api/auth/logout", { method: "POST" }); } catch (e) { /* local sign-out still wins */ } }
      }
      clearToken();
      clearRefresh();
    },
  };
})();
