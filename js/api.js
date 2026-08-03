// Shared API client for Sitting Pretty (public site + dashboard).
// Demo: same-origin /api (server/server.mjs). Production: set window.SP_CONFIG
// = {apiBase} in a config.js loaded before this file (see RUNBOOK.md).
window.SP = (() => {
  const base = (window.SP_CONFIG && window.SP_CONFIG.apiBase) || "";
  const KEY = "sp_token";

  async function request(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const token = localStorage.getItem(KEY);
    if (token) headers.Authorization = "Bearer " + token;
    let body = opts.body;
    if (body != null && typeof body !== "string") body = JSON.stringify(body);
    const res = await fetch(base + path, Object.assign({}, opts, { headers, body }));
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      if (res.status === 401) localStorage.removeItem(KEY);
      throw new Error((data && data.error) || "Something went wrong (" + res.status + ")");
    }
    return data;
  }

  return {
    request,
    hasToken: () => !!localStorage.getItem(KEY),
    requestCode: (email) => request("/api/auth/request-code", { method: "POST", body: { email } }),
    verify: async (email, code) => {
      const data = await request("/api/auth/verify", { method: "POST", body: { email, code } });
      if (data && data.token) localStorage.setItem(KEY, data.token);
      return data;
    },
    me: () => request("/api/me"),
    updateMe: (fields) => request("/api/me", { method: "POST", body: fields }),
    logout: () => { localStorage.removeItem(KEY); },
  };
})();
