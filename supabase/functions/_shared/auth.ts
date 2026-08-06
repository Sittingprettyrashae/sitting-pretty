// Auth for the production API.
//
// There are no custom sign-in endpoints in production. The browser talks to
// Supabase Auth directly with supabase-js (RUNBOOK step 2b), and whichever
// way someone signs in, Supabase hands back the same kind of access token:
//
//   password  supabase.auth.signUp({ email, password, options: { data } })
//             supabase.auth.signInWithPassword({ email, password })
//   google    supabase.auth.signInWithOAuth({ provider: "google" })
//   code      supabase.auth.signInWithOtp({ email })
//             supabase.auth.verifyOtp({ email, token, type })
//   reset     supabase.auth.resetPasswordForEmail(email)
//             then supabase.auth.updateUser({ password })
//
// That access token is what the frontend sends as Authorization: Bearer
// <token> on every call to this API, exactly like the mock's opaque token.
//
// This module validates the JWT and resolves it to a clients row. A
// Google-issued token and a password-issued token for the same person are
// the same auth user (Supabase links identities that share a confirmed
// email), so they resolve to the same clients row, and the row is created
// on first sight if the database trigger has not already done it.

import { adminDb } from "./db.ts";
import { HttpError } from "./http.ts";

export interface ClientRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  is_admin: boolean;
  has_password: boolean;
  auth_provider: "password" | "google" | "code";
  created_at: string;
}

// Ask Postgres to (re)build the clients row from auth.users + auth.identities.
// Same function the auth triggers call, so there is exactly one definition of
// has_password and auth_provider. Returns null when the email is already held
// by another account and cannot be safely adopted (see schema.sql).
async function syncClient(userId: string): Promise<ClientRow | null> {
  const db = adminDb();
  const { data, error } = await db.rpc("sp_sync_client", { uid: userId });
  if (error) {
    console.error("sp_sync_client failed:", error);
    throw new HttpError(500, "Could not load your account");
  }
  // Same trap as sp_book_hold: a function returning a NULL composite comes back
  // as one row of all-null columns, not as nothing. Without checking a real
  // column, a missing client would look like a signed-in client with no id.
  const row = Array.isArray(data) ? data[0] : data;
  const client = row && (row as ClientRow).id ? (row as ClientRow) : null;
  return client;
}

export async function requireClient(req: Request): Promise<ClientRow> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Sign in to continue");

  const db = adminDb();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    throw new HttpError(401, "Your session expired. Sign in again");
  }
  const user = data.user;

  const found = await db.from("clients").select("*").eq("id", user.id).maybeSingle();
  if (found.error) throw new HttpError(500, "Could not load your account");

  if (found.data) {
    const row = found.data as ClientRow;
    // Self-heal if the row drifted from the account: this catches a database
    // that predates the auth triggers, and the moment Google gets linked to
    // an account that used to be code-only.
    const providers = [
      (user.app_metadata?.provider as string | undefined) ?? "",
      ...((user.app_metadata?.providers as string[] | undefined) ?? []),
    ];
    const googleLinked = providers.includes("google");
    const drifted = (googleLinked && row.auth_provider !== "google") ||
      (row.email ?? "").toLowerCase() !== (user.email ?? "").toLowerCase();
    if (!drifted) return row;
    const refreshed = await syncClient(user.id);
    return refreshed ?? row;
  }

  // No row yet. Normal on the very first request after sign-up if the request
  // beat the trigger, and the recovery path if the trigger is missing.
  const created = await syncClient(user.id);
  if (!created) {
    throw new HttpError(
      409,
      "That email is already set up with a different sign-in method. Sign in the way you did before, or reset your password",
    );
  }
  return created;
}

export async function requireAdmin(req: Request): Promise<ClientRow> {
  const client = await requireClient(req);
  if (!client.is_admin) throw new HttpError(403, "Admin only");
  return client;
}
