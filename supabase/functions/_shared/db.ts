// Service-role Supabase client for the edge functions.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
// the edge runtime; they are never set by hand and never reach the browser.
// The service role bypasses RLS, so every handler must do its own
// authorization via _shared/auth.ts first.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

let cached: SupabaseClient | null = null;

export function adminDb(): SupabaseClient {
  if (!cached) {
    cached = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return cached;
}
