// Sitting Pretty frontend config.
//
// LOAD ORDER MATTERS: this file must be included BEFORE js/api.js in both
// index.html and dashboard.html:
//
//   <script src="js/config.js"></script>
//   <script src="js/api.js"></script>
//
// js/api.js reads window.SP_CONFIG.apiBase and prefixes every API call with
// it. Every call path already starts with "/api/...", so apiBase is
// everything BEFORE the /api part:
//
//   Demo (local mock server, same origin):  apiBase: ""
//   Production (Supabase edge function):
//     apiBase: "https://YOUR-PROJECT-REF.supabase.co/functions/v1"
//     (no trailing /api and no trailing slash; the deployed function is
//     named "api", so the final URL becomes .../functions/v1/api/...)
//
// supabaseUrl and supabaseAnonKey are reserved for the production sign-in
// switch (Supabase Auth email OTP via signInWithOtp / verifyOtp). js/api.js
// does NOT read them yet; see RUNBOOK.md step 5 for the open item. The anon
// public key is safe to publish in this file. The service role key is NOT:
// it must never appear in any frontend file.
window.SP_CONFIG = {
  // Demo default: same-origin mock server (server/server.mjs).
  apiBase: "",

  // Production values (replace and commit before deploying to Pages):
  // apiBase: "https://YOUR-PROJECT-REF.supabase.co/functions/v1",
  supabaseUrl: "", // production: "https://YOUR-PROJECT-REF.supabase.co"
  supabaseAnonKey: "", // production: "REPLACE-WITH-ANON-PUBLIC-KEY"
};
