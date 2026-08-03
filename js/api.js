// Shared API client for Sitting Pretty (public site + dashboard).
// Demo: same-origin /api (server/server.mjs). Production: set window.SP_CONFIG
// = {apiBase} in a config.js loaded before this file (see RUNBOOK.md).
//
// Three ways in, all landing on {token, client} (see API.md "Auth"):
//   password  -> SP.signup / SP.login
//   Google    -> SP.loginWithGoogle() (round trip, returns with #sp_token=...)
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
    if (!m) return;
    setToken(decodeURIComponent(m[1]));
    cameBackFromRedirect = true;
    const rest = hash.replace(/[#&]sp_token=[^&]*/, "").replace(/^#?&/, "#");
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
    if (token) headers.Authorization = "Bearer " + token;
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
      if (res.status === 401 && !/\/api\/auth\//.test(path)) clearToken();
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

  return {
    request,
    PASSWORD_HINT,
    passwordProblem,
    emailLooksOk,
    hasToken: () => !!getToken(),
    // True when this page load arrived back from the Google round trip.
    returnedFromRedirect: () => cameBackFromRedirect,

    signup: (email, password, name, phone) => authRequest("/api/auth/signup", {
      email: String(email || "").trim().toLowerCase(),
      password: String(password || ""),
      name: name ? String(name).trim() : undefined,
      phone: phone ? String(phone).trim() : undefined,
    }),

    login: (email, password) => authRequest("/api/auth/login", {
      email: String(email || "").trim().toLowerCase(),
      password: String(password || ""),
    }),

    // Full-page trip to Google and back to this same page.
    loginWithGoogle: (redirectPath) => {
      const back = redirectPath || (window.location.pathname + window.location.search);
      window.location.href = base + "/api/auth/google/start?redirect=" + encodeURIComponent(back);
    },

    requestCode: (email, purpose) => request("/api/auth/request-code", {
      method: "POST",
      body: { email: String(email || "").trim().toLowerCase(), purpose: purpose || "login" },
    }),
    verify: (email, code) => authRequest("/api/auth/verify", {
      email: String(email || "").trim().toLowerCase(),
      code: String(code || "").trim(),
    }),

    // Sets or replaces the password for whoever is signed in right now. The
    // server rotates every session on a password change and hands back a fresh
    // token, so store it or the client is signed straight back out.
    setPassword: (password) => authRequest("/api/auth/set-password", { password: String(password || "") }),

    me: () => request("/api/me"),
    updateMe: (fields) => request("/api/me", { method: "POST", body: fields }),

    // Tell the server to drop the session, then forget it locally either way.
    logout: async () => {
      if (getToken()) {
        try { await request("/api/auth/logout", { method: "POST" }); } catch (e) { /* local sign-out still wins */ }
      }
      clearToken();
    },
  };
})();
