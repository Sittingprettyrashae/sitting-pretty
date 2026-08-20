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
  // Google sign-in. Both of these are set for you by
  // scripts/finish-google-oauth.sh once her OAuth client exists; until then the
  // button stays hidden, because an unconfigured provider sends the visitor to
  // a raw Supabase JSON error page.
  //
  // googleClientId is the web client id from HER Google Cloud project. It is a
  // public value by design (it ships in every page that offers Google sign-in)
  // -- the client SECRET is not here and never should be. With it set, the site
  // uses Google Identity Services: the prompt is bound to this domain and says
  // sittingprettyrashae.com instead of the Supabase project URL, and sign-in
  // happens without leaving the page. See js/api.js "Google, the One Tap way".
  googleEnabled: true,
  googleClientId: "114448080261-uvmiji3ses3t9ebr7cs55jkhutstjeit.apps.googleusercontent.com",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmZmZndWltY2F3anh0Ymllc3FuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyOTU5MjAsImV4cCI6MjEwMTg3MTkyMH0.qzQ-KXDVstfmGB0VlxydkRrvN0CAz-K4AzwqbVopJPk",
};
