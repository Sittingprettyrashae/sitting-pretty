// Admin endpoints (auth + is_admin, else 403). Contract: API.md "Admin".
// Authorization happens here via requireAdmin; the database work runs with
// the service role key.

import { requireAdmin } from "../_shared/auth.ts";
import { adminDb } from "../_shared/db.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";
import {
  notifyBookingCanceled,
  notifyBookingConfirmed,
  notifyBroadcast,
} from "../_shared/notify.ts";

export async function handleAdmin(req: Request, path: string): Promise<Response> {
  await requireAdmin(req);
  const url = new URL(req.url);

  if (req.method === "GET" && path === "/admin/bookings") {
    return await listBookings(url);
  }
  const statusMatch = path.match(/^\/admin\/bookings\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    return await setBookingStatus(req, statusMatch[1]);
  }
  if (path === "/admin/blocked-days") {
    if (req.method === "GET") return json({ days: await blockedDays() });
    if (req.method === "POST") return await addBlockedDay(req);
  }
  const dayMatch = path.match(/^\/admin\/blocked-days\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === "DELETE" && dayMatch) {
    return await removeBlockedDay(dayMatch[1]);
  }
  if (req.method === "GET" && path === "/admin/clients") {
    return await listClients();
  }
  if (req.method === "POST" && path === "/admin/broadcast") {
    return await broadcast(req);
  }

  throw new HttpError(404, "Not found");
}

async function listBookings(url: URL): Promise<Response> {
  let query = adminDb()
    .from("bookings")
    .select("*")
    .order("date", { ascending: true })
    .order("time", { ascending: true });
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const status = url.searchParams.get("status");
  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);
  if (status) query = query.eq("status", status);
  const res = await query;
  if (res.error) throw new HttpError(500, "Could not load bookings");
  return json({ bookings: res.data ?? [] });
}

async function setBookingStatus(req: Request, bookingId: string): Promise<Response> {
  const body = await readJson(req);
  const status = String(body.status ?? "");
  if (!["confirmed", "completed", "canceled"].includes(status)) {
    throw new HttpError(400, "status must be confirmed, completed, or canceled");
  }

  const db = adminDb();
  const found = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (found.error) throw new HttpError(500, "Could not load the booking");
  if (!found.data) throw new HttpError(404, "Booking not found");
  const before = found.data;
  if (before.status === status) return json({ booking: before });

  const patch: Record<string, unknown> = { status };
  if (status === "canceled") patch.canceled_by = "admin";
  const updated = await db
    .from("bookings")
    .update(patch)
    .eq("id", bookingId)
    .select("*")
    .single();
  if (updated.error) throw new HttpError(500, "Could not update the booking");

  if (status === "canceled") await notifyBookingCanceled(updated.data, "admin");
  // Admin confirm counts as the "confirmed" event (ARCHITECTURE.md), same
  // as a paid deposit.
  if (status === "confirmed") await notifyBookingConfirmed(updated.data);

  return json({ booking: updated.data });
}

async function blockedDays(): Promise<Array<{ date: string; reason: string }>> {
  const res = await adminDb()
    .from("blocked_days")
    .select("date, reason")
    .order("date", { ascending: true });
  if (res.error) throw new HttpError(500, "Could not load blocked days");
  return (res.data ?? []) as Array<{ date: string; reason: string }>;
}

async function addBlockedDay(req: Request): Promise<Response> {
  const body = await readJson(req);
  const date = String(body.date ?? "");
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  const res = await adminDb()
    .from("blocked_days")
    .upsert({ date, reason }, { onConflict: "date" });
  if (res.error) throw new HttpError(500, "Could not block that day");
  return json({ days: await blockedDays() });
}

async function removeBlockedDay(date: string): Promise<Response> {
  const res = await adminDb().from("blocked_days").delete().eq("date", date);
  if (res.error) throw new HttpError(500, "Could not unblock that day");
  return json({ days: await blockedDays() });
}

async function listClients(): Promise<Response> {
  const db = adminDb();
  const clientsRes = await db
    .from("clients")
    .select("id, email, name, phone")
    .order("created_at", { ascending: true });
  if (clientsRes.error) throw new HttpError(500, "Could not load clients");
  const bookingsRes = await db.from("bookings").select("client_id, date");
  if (bookingsRes.error) throw new HttpError(500, "Could not load clients");

  const stats = new Map<string, { count: number; last: string | null }>();
  for (const b of bookingsRes.data ?? []) {
    const s = stats.get(b.client_id) ?? { count: 0, last: null };
    s.count += 1;
    if (!s.last || b.date > s.last) s.last = b.date;
    stats.set(b.client_id, s);
  }

  const clients = (clientsRes.data ?? []).map((c) => ({
    id: c.id,
    email: c.email,
    name: c.name,
    phone: c.phone,
    bookings_count: stats.get(c.id)?.count ?? 0,
    last_booking: stats.get(c.id)?.last ?? null,
  }));
  return json({ clients });
}

async function broadcast(req: Request): Promise<Response> {
  const body = await readJson(req);
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!subject || !message) throw new HttpError(400, "subject and message are required");

  const db = adminDb();
  const clientsRes = await db.from("clients").select("id, email, name, phone");
  if (clientsRes.error) throw new HttpError(500, "Could not load clients");

  let sent = 0;
  for (const client of clientsRes.data ?? []) {
    await notifyBroadcast(client, subject, message);
    sent += 1;
  }

  const logged = await db.from("broadcasts").insert({ subject, message, sent_count: sent });
  if (logged.error) console.error("broadcasts insert failed:", logged.error.message);

  return json({ sent });
}
