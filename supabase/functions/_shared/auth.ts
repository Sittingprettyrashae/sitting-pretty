// Auth for the production API.
//
// There are no custom request-code / verify endpoints in production:
// POST /api/auth/request-code maps to supabase.auth.signInWithOtp({ email })
// and POST /api/auth/verify maps to supabase.auth.verifyOtp({ email, token,
// type: "email" }), both called client-side in js/api.js against Supabase
// Auth (RUNBOOK step 5). The access token Supabase returns is what the
// frontend sends as Authorization: Bearer <token>, exactly like the mock's
// opaque token.
//
// This module validates that JWT and loads the caller's clients row.

import { adminDb } from "./db.ts";
import { HttpError } from "./http.ts";

export interface ClientRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  is_admin: boolean;
  created_at: string;
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
  if (found.data) return found.data as ClientRow;

  // The on_auth_user_created trigger normally creates this row on first
  // sign-in; recover here if it is ever missing.
  const inserted = await db
    .from("clients")
    .insert({ id: user.id, email: user.email })
    .select("*")
    .single();
  if (inserted.error) throw new HttpError(500, "Could not load your account");
  return inserted.data as ClientRow;
}

export async function requireAdmin(req: Request): Promise<ClientRow> {
  const client = await requireClient(req);
  if (!client.is_admin) throw new HttpError(403, "Admin only");
  return client;
}
