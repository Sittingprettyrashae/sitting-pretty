// Sitting Pretty frontend config.
//
// LOAD ORDER MATTERS: this file must be included BEFORE js/api.js in both
// index.html and dashboard.html.
//
// These two values are meant to be public. The anon key is designed to sit in
// a browser: it grants nothing on its own, and row level security in her
// database is what actually decides who can read or write what. The secret
// keys (service_role, Stripe, her database password) live in
// server/.env.local, which is gitignored, and in Supabase's own secret store.
window.SP_CONFIG = {
  // Her Supabase edge function. Every call path starts with /api/..., so this
  // is everything before that. Set to "" to run against the local demo server.
  apiBase: "https://zfffguimcawjxtbiesqn.supabase.co/functions/v1",
  supabaseUrl: "https://zfffguimcawjxtbiesqn.supabase.co",
  // Flip to true only AFTER a Google OAuth client is set up in her Google
  // Cloud project and pasted into Supabase (Authentication > Providers >
  // Google). Until then the "Continue with Google" button is hidden, because a
  // disabled provider sends the visitor to a raw Supabase JSON error page.
  googleEnabled: false,
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmZmZndWltY2F3anh0Ymllc3FuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyOTU5MjAsImV4cCI6MjEwMTg3MTkyMH0.qzQ-KXDVstfmGB0VlxydkRrvN0CAz-K4AzwqbVopJPk",
};
