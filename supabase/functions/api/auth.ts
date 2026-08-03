// Auth endpoints that still need a server in production.
//
// Almost nothing does. Signing up, signing in with a password, signing in
// with Google, sending an email code, and setting a new password are all
// native Supabase Auth calls made from the browser with supabase-js
// (RUNBOOK step 2b), so they never touch this function. What is left:
//
//   POST /api/auth/bootstrap  make sure the signed-in token has a clients
//                             row, seed the profile from the sign-up form,
//                             and hand back the client object so the
//                             frontend can store { token, client } exactly
//                             like the demo does
//   POST /api/auth/logout     really end the session server-side, so the
//                             refresh token cannot be used again
//
// Every other /api/auth/* path answers 410 with the supabase-js call that
// replaced it, so a stale build fails loudly instead of silently.

import { requireClient } from "../_shared/auth.ts";
import { adminDb } from "../_shared/db.ts";
import { errorResponse, HttpError, json, readJson } from "../_shared/http.ts";

const REPLACED_BY: Record<string, string> = {
  "/auth/signup": "supabase.auth.signUp({ email, password, options: { data: { name, phone } } })",
  "/auth/login": "supabase.auth.signInWithPassword({ email, password })",
  "/auth/google/start": 'supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } })',
  "/auth/google/callback": "handled by Supabase at /auth/v1/callback, then by supabase-js in the browser",
  "/auth/request-code": "supabase.auth.signInWithOtp({ email }), or resetPasswordForEmail(email) for a reset",
  "/auth/verify": 'supabase.auth.verifyOtp({ email, token, type: "email" })',
  "/auth/set-password": "supabase.auth.updateUser({ password })",
};

export async function handleAuth(req: Request, path: string): Promise<Response> {
  if (path === "/auth/bootstrap") {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    return await bootstrap(req);
  }

  if (path === "/auth/logout") {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    return await logout(req);
  }

  // The `error` string can reach a client's screen, so it stays plain English.
  // The SDK call belongs to whoever is wiring the frontend, not to someone
  // trying to book an appointment, so it travels in a separate field the UI
  // never renders.
  const hint = REPLACED_BY[path];
  return json(
    {
      error: "Sign-in is not available at this address. Reload the booking page and try again.",
      developer_hint: hint
        ? `This endpoint is handled by Supabase Auth in the browser. Use ${hint}`
        : "Sign-in runs through Supabase Auth in the browser, not this API",
    },
    410,
  );
}

// POST /api/auth/bootstrap  { name?, phone? } -> { client }
//
// Called once right after signUp, signInWithPassword, an OAuth return, or
// verifyOtp. requireClient does the real work: it validates the token and
// creates or repairs the clients row (schema.sql sp_sync_client), which is
// also where a Google sign-in gets attached to the account she already had.
// name and phone from the sign-up form are only used to FILL BLANKS, never
// to overwrite a profile she has already edited.
async function bootstrap(req: Request): Promise<Response> {
  const client = await requireClient(req);

  let body: Record<string, unknown> = {};
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    body = await readJson(req).catch(() => ({}));
  }

  const patch: Record<string, string> = {};
  if (!client.name && typeof body.name === "string" && body.name.trim()) {
    patch.name = body.name.trim().slice(0, 120);
  }
  if (!client.phone && typeof body.phone === "string" && body.phone.trim()) {
    patch.phone = body.phone.trim().slice(0, 30);
  }
  if (Object.keys(patch).length === 0) return json({ client });

  const res = await adminDb()
    .from("clients")
    .update(patch)
    .eq("id", client.id)
    .select("*")
    .single();
  if (res.error) return json({ client });
  return json({ client: res.data });
}

// POST /api/auth/logout -> { ok: true }
//
// supabase.auth.signOut() already clears the browser, but the refresh token
// keeps working until it expires. This revokes it for real.
async function logout(req: Request): Promise<Response> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: true });
  const { error } = await adminDb().auth.admin.signOut(token, "global");
  if (error) console.error("signOut failed:", error);
  return json({ ok: true });
}
