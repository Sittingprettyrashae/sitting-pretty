// GET /api/me  -> { client, bookings } (their bookings, newest first)
// POST /api/me -> { client } (update name and/or phone)

import { requireClient } from "../_shared/auth.ts";
import { adminDb } from "../_shared/db.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";
import { withMoneyAll } from "../_shared/money.ts";

export async function handleMe(req: Request): Promise<Response> {
  const client = await requireClient(req);
  const db = adminDb();

  if (req.method === "GET") {
    const res = await db
      .from("bookings")
      .select("*")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false });
    if (res.error) throw new HttpError(500, "Could not load your bookings");
    // Every booking carries what is paid and what is left (_shared/money.ts),
    // so the dashboard never has to do money math of its own.
    //
    // notes stays behind: since Add Booking, that column can hold Ebony's
    // OWN annotation about the client ("comp'd, always late"), and /me goes
    // to the very person it is about. Clients never needed it back -- the
    // note they typed at booking was addressed to her.
    const bookings = withMoneyAll(res.data ?? []).map((b) => {
      const pub = { ...(b as Record<string, unknown>) };
      delete pub.notes;
      return pub;
    });
    return json({ client, bookings });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const patch: Record<string, string> = {};
    if (typeof body.name === "string") patch.name = body.name.trim().slice(0, 120);
    if (typeof body.phone === "string") patch.phone = body.phone.trim().slice(0, 30);
    if (Object.keys(patch).length === 0) return json({ client });
    const res = await db.from("clients").update(patch).eq("id", client.id).select("*").single();
    if (res.error) throw new HttpError(500, "Could not update your profile");
    return json({ client: res.data });
  }

  throw new HttpError(405, "Method not allowed");
}
