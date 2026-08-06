// Admin endpoints (auth + is_admin, else 403). Contract: API.md "Admin".
// Authorization happens here via requireAdmin; the database work runs with
// the service role key.

import { requireAdmin } from "../_shared/auth.ts";
import { adminDb } from "../_shared/db.ts";
import { storeFlyer } from "../_shared/flyer.ts";
import {
  chicagoNow,
  type DayHours,
  fitsWithin,
  parseHoursInput,
  readHours,
  writeHours,
} from "../_shared/hours.ts";
import { HttpError, json, readJson, readJsonOptional } from "../_shared/http.ts";
import { balanceCentsFor, paidCents, withMoney, withMoneyAll } from "../_shared/money.ts";
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
  const markPaidMatch = path.match(/^\/admin\/bookings\/([^/]+)\/mark-paid$/);
  if (req.method === "POST" && markPaidMatch) {
    return await markPaid(req, markPaidMatch[1]);
  }
  if (path === "/admin/blocked-days") {
    if (req.method === "GET") return json({ days: await blockedDays() });
    if (req.method === "POST") return await addBlockedDay(req);
  }
  const dayMatch = path.match(/^\/admin\/blocked-days\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === "DELETE" && dayMatch) {
    return await removeBlockedDay(dayMatch[1]);
  }
  if (path === "/admin/hours") {
    if (req.method === "GET") return json({ days: await readHours() });
    if (req.method === "PUT") return await saveHours(req);
  }
  if (req.method === "GET" && path === "/admin/clients") {
    return await listClients();
  }
  if (req.method === "POST" && path === "/admin/broadcast") {
    return await broadcast(req);
  }
  if (req.method === "GET" && path === "/admin/broadcasts") {
    return await listBroadcasts();
  }

  throw new HttpError(404, "Not found");
}

// PUT /admin/hours { days:[{weekday, closed, open?, close?}] }
//   -> { days, affected:[Booking] }
//
// She owns her own schedule. The whole week is validated before anything is
// written, so a rejected save never leaves her half changed.
//
// Appointments already on the books are NEVER touched. If she narrows a day,
// the client who booked it keeps that time: it was promised to her. What she
// gets back is `affected`, the upcoming appointments that now sit outside her
// hours, so she can decide herself which to move and which to keep.
async function saveHours(req: Request): Promise<Response> {
  const body = await readJson(req);
  const days = parseHoursInput(body);
  const saved = await writeHours(days);
  return json({ days: saved, affected: await bookingsOutsideHours(saved) });
}

async function bookingsOutsideHours(days: DayHours[]): Promise<unknown[]> {
  const today = chicagoNow().date;
  const res = await adminDb()
    .from("bookings")
    .select("*")
    .gte("date", today)
    .neq("status", "canceled")
    .order("date", { ascending: true })
    .order("time", { ascending: true });
  // Her hours are already saved at this point. A failure here costs her the
  // heads-up list, not the change she just made, so never fail the request.
  if (res.error) {
    console.error("Could not check bookings against new hours:", res.error.message);
    return [];
  }
  const outside = (res.data ?? []).filter((b) => {
    const weekday = new Date(`${b.date}T00:00:00Z`).getUTCDay();
    return !fitsWithin(days[weekday], b.time as string, b.duration_min as number);
  });
  return withMoneyAll(outside);
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
  return json({ bookings: withMoneyAll(res.data ?? []) });
}

// POST /admin/bookings/:id/mark-paid { amount_cents? } -> { booking }
//
// Ebony settled up with the client in the chair: cash, Zelle, her card reader,
// however she took it. Mirrors the demo route in server/server.mjs.
// amount_cents is for the services whose final price depends on the hair
// ("$50+"), where there is no computed balance to settle; otherwise the known
// balance is what gets recorded.
async function markPaid(req: Request, bookingId: string): Promise<Response> {
  const body = await readJsonOptional(req);
  const db = adminDb();

  const found = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (found.error) throw new HttpError(500, "Could not load the booking");
  const booking = found.data;
  if (!booking) throw new HttpError(404, "Booking not found");
  if (booking.status === "canceled") throw new HttpError(409, "That appointment was cancelled.");

  const supplied = body.amount_cents;
  const amount = typeof supplied === "number" && Number.isFinite(supplied) && supplied > 0
    ? Math.round(supplied)
    : balanceCentsFor(booking);

  const patch: Record<string, unknown> = {
    paid_cents: paidCents(booking) + (amount ?? 0),
    paid_in_full: true,
    paid_in_person: true,
  };
  // Money in hand also settles the question of whether the appointment is on.
  if (booking.status === "awaiting_deposit" || booking.status === "request") {
    patch.status = "confirmed";
  }

  const updated = await db
    .from("bookings")
    .update(patch)
    .eq("id", bookingId)
    .select("*")
    .single();
  if (updated.error) throw new HttpError(500, "Could not record the payment");

  return json({ booking: withMoney(updated.data) });
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
  if (before.status === status) return json({ booking: withMoney(before) });

  const patch: Record<string, unknown> = { status };
  if (status === "canceled") patch.canceled_by = "admin";
  const updated = await db
    .from("bookings")
    .update(patch)
    .eq("id", bookingId)
    .select("*")
    .single();
  if (updated.error) {
    // 23P01: putting this one back on the calendar would double-book the time,
    // because another appointment or a live hold now sits there. Say so
    // plainly instead of a blank failure.
    if ((updated.error as { code?: string }).code === "23P01") {
      throw new HttpError(409, "Someone else has that time now. Pick a new time for this one.");
    }
    throw new HttpError(500, "Could not update the booking");
  }

  if (status === "canceled") await notifyBookingCanceled(updated.data, "admin");
  // Admin confirm counts as the "confirmed" event (ARCHITECTURE.md), same
  // as a paid deposit.
  if (status === "confirmed") await notifyBookingConfirmed(updated.data);

  return json({ booking: withMoney(updated.data) });
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
    // Her own account is not one of her clients.
    .eq("is_admin", false)
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

// POST /admin/broadcast { subject, message, image? } -> { sent, image_url? }
//
// One message to every client, with an optional flyer. A flyer on its own is
// a valid send: sometimes the picture IS the message.
async function broadcast(req: Request): Promise<Response> {
  const body = await readJson(req);
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const image = typeof body.image === "string" ? body.image.trim() : "";
  if (!subject && !message && !image) {
    throw new HttpError(400, "Add a subject, a message, or a flyer before you send.");
  }

  // Store the flyer BEFORE anything goes out. If the picture is too big or the
  // upload fails, she gets one plain error and nobody has been messaged yet;
  // uploading partway through the list would send some clients the flyer and
  // the rest the same words with nothing attached.
  const imageUrl = image ? await storeFlyer(image) : null;

  const db = adminDb();
  const clientsRes = await db.from("clients").select("id, email, name, phone").eq("is_admin", false);
  if (clientsRes.error) throw new HttpError(500, "Could not load clients");

  let sent = 0;
  for (const client of clientsRes.data ?? []) {
    await notifyBroadcast(client, subject, message, imageUrl);
    sent += 1;
  }

  const logged = await db
    .from("broadcasts")
    .insert({ subject, message, sent_count: sent, image_url: imageUrl });
  if (logged.error) console.error("broadcasts insert failed:", logged.error.message);

  return imageUrl ? json({ sent, image_url: imageUrl }) : json({ sent });
}

// GET /admin/broadcasts -> { broadcasts:[{ts, subject, message, image_url?, sent}] }
// Newest first, so she can see what she has already sent before sending again.
async function listBroadcasts(): Promise<Response> {
  const res = await adminDb()
    .from("broadcasts")
    .select("subject, message, image_url, sent_count, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (res.error) throw new HttpError(500, "Could not load what you have sent");
  const broadcasts = (res.data ?? []).map((b) => ({
    ts: b.created_at,
    subject: b.subject,
    message: b.message,
    // Left out entirely when there was no flyer, per API.md.
    ...(b.image_url ? { image_url: b.image_url } : {}),
    sent: b.sent_count,
  }));
  return json({ broadcasts });
}
