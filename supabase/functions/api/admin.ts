// Admin endpoints (auth + is_admin, else 403). Contract: API.md "Admin".
// Authorization happens here via requireAdmin; the database work runs with
// the service role key.

import { requireAdmin } from "../_shared/auth.ts";
import { loadAllRows, slugify } from "../_shared/catalog.ts";
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
  if (path === "/admin/services") {
    if (req.method === "GET") return await listServices();
    if (req.method === "POST") return await addService(req);
  }
  const svcMatch = path.match(/^\/admin\/services\/([a-z0-9-]+)$/);
  if (req.method === "PUT" && svcMatch) {
    return await editService(req, svcMatch[1]);
  }
  const svcActiveMatch = path.match(/^\/admin\/services\/([a-z0-9-]+)\/active$/);
  if (req.method === "POST" && svcActiveMatch) {
    return await setServiceActive(req, svcActiveMatch[1]);
  }
  if (req.method === "GET" && path === "/admin/clients") {
    return await listClients();
  }
  if (req.method === "GET" && path === "/admin/leads") {
    return await listLeads();
  }
  const leadDeleteMatch = path.match(/^\/admin\/leads\/([^/]+)$/);
  if (req.method === "DELETE" && leadDeleteMatch) {
    return await removeLead(leadDeleteMatch[1]);
  }
  if (req.method === "GET" && path === "/admin/reviews") {
    return await listReviews();
  }
  const reviewStatusMatch = path.match(/^\/admin\/reviews\/([^/]+)\/status$/);
  if (req.method === "POST" && reviewStatusMatch) {
    return await setReviewStatus(req, reviewStatusMatch[1]);
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

// ---------------------------------------------------------------------------
// Her menu (the Menu tab). Every mutation writes the services table; the
// public site and the booking engine read it live, so a price she saves is
// the price the next client pays. Existing bookings are never touched: they
// snapshotted their price when they were made.
// ---------------------------------------------------------------------------

const PRICE_RE = /^\$\d+\+?$/;

function cleanServiceFields(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (body.price !== undefined) {
    const price = String(body.price).trim().replace(/\s+/g, "");
    const normalized = price.startsWith("$") ? price : "$" + price;
    if (!PRICE_RE.test(normalized)) {
      throw new HttpError(400, 'Price should look like "$75" or "$50+" (the + means "and up").');
    }
    out.price = normalized;
  }
  if (body.duration_min !== undefined) {
    const d = Number(body.duration_min);
    if (!Number.isInteger(d) || d < 15 || d > 720) {
      throw new HttpError(400, "How long it takes should be between 15 minutes and 12 hours.");
    }
    out.duration_min = d;
  }
  if (body.deposit_cents !== undefined) {
    if (body.deposit_cents === null || body.deposit_cents === "") {
      out.deposit_cents = null; // no set deposit: she confirms by text, request-only
    } else {
      const c = Number(body.deposit_cents);
      if (!Number.isInteger(c) || c <= 0 || c > 100000000) {
        throw new HttpError(400, "The deposit should be a dollar amount, or empty for none.");
      }
      out.deposit_cents = c;
    }
  }
  if (body.note !== undefined) out.note = String(body.note).trim().slice(0, 300);
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 120);
    if (name.length < 2) throw new HttpError(400, "Give the style a name.");
    out.name = name;
  }
  return out;
}

const serviceShape =
  "service_id, cat, name, price, duration_min, deposit_cents, note, active, cat_order, sort_order";

async function listServices(): Promise<Response> {
  const rows = await loadAllRows();
  return json({ services: rows });
}

// POST /admin/services { cat, name, price, duration_min, deposit_cents?, note? }
async function addService(req: Request): Promise<Response> {
  const body = await readJson(req);
  const cat = String(body.cat ?? "").trim().slice(0, 80);
  if (cat.length < 2) throw new HttpError(400, "Pick or type a category for this style.");
  const fields = cleanServiceFields(body);
  if (!fields.name) throw new HttpError(400, "Give the style a name.");
  if (!fields.price) throw new HttpError(400, "Give the style a price.");
  if (fields.duration_min === undefined) {
    throw new HttpError(400, "Say how long this style takes.");
  }
  const serviceId = slugify(cat + "--" + String(fields.name));

  const db = adminDb();
  const existing = await db.from("services").select(serviceShape).eq("service_id", serviceId).maybeSingle();
  if (existing.error) throw new HttpError(500, "Could not save that style");
  if (existing.data && existing.data.active) {
    throw new HttpError(409, "That style already exists in this category. Edit it instead.");
  }

  // Where in the menu it lands: with its category, at the end.
  const catRows = await db.from("services").select("cat_order, sort_order").eq("cat", cat)
    .order("sort_order", { ascending: false }).limit(1);
  const maxCat = await db.from("services").select("cat_order").order("cat_order", { ascending: false }).limit(1);
  const catOrder = catRows.data?.length
    ? catRows.data[0].cat_order
    : ((maxCat.data?.[0]?.cat_order ?? -1) + 1);
  const sortOrder = (catRows.data?.[0]?.sort_order ?? -1) + 1;

  const row = {
    service_id: serviceId,
    cat,
    ...fields,
    deposit_cents: fields.deposit_cents === undefined ? null : fields.deposit_cents,
    note: fields.note ?? "",
    active: true,
    cat_order: catOrder,
    sort_order: sortOrder,
  };
  // A style she removed earlier comes back to life with the new details.
  const saved = existing.data
    ? await db.from("services").update(row).eq("service_id", serviceId).select(serviceShape).single()
    : await db.from("services").insert(row).select(serviceShape).single();
  if (saved.error) throw new HttpError(500, "Could not save that style");
  return json({ service: saved.data });
}

// PUT /admin/services/:service_id { price?, duration_min?, deposit_cents?, note?, name? }
// The slug never changes, even on a rename, so bookings keep resolving.
async function editService(req: Request, serviceId: string): Promise<Response> {
  const fields = cleanServiceFields(await readJson(req));
  if (!Object.keys(fields).length) throw new HttpError(400, "Nothing to change.");
  const res = await adminDb()
    .from("services")
    .update(fields)
    .eq("service_id", serviceId)
    .select(serviceShape)
    .maybeSingle();
  if (res.error) throw new HttpError(500, "Could not save that change");
  if (!res.data) throw new HttpError(404, "That style is not on the menu");
  return json({ service: res.data });
}

// POST /admin/services/:service_id/active { active } — remove/restore, softly.
async function setServiceActive(req: Request, serviceId: string): Promise<Response> {
  const body = await readJson(req);
  if (typeof body.active !== "boolean") throw new HttpError(400, "active must be true or false");
  const res = await adminDb()
    .from("services")
    .update({ active: body.active })
    .eq("service_id", serviceId)
    .select(serviceShape)
    .maybeSingle();
  if (res.error) throw new HttpError(500, "Could not update that style");
  if (!res.data) throw new HttpError(404, "That style is not on the menu");
  return json({ service: res.data });
}

// GET /admin/leads -> { leads: [{id, name, email, phone, source, ts}] }
// Her waitlist: people the popup collected who have not booked yet. Newest
// first so the freshest interest is on top.
async function listLeads(): Promise<Response> {
  const res = await adminDb()
    .from("leads")
    .select("id, name, email, phone, source, created_at")
    .order("created_at", { ascending: false });
  if (res.error) throw new HttpError(500, "Could not load your waitlist");
  const leads = (res.data ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    email: l.email,
    phone: l.phone,
    source: l.source,
    ts: l.created_at,
  }));
  return json({ leads });
}

// DELETE /admin/leads/:id -> { leads } (the fresh list)
// The exit door the popup's "no spam" promise leans on: someone asks off the
// list, she removes them in one tap.
async function removeLead(leadId: string): Promise<Response> {
  const res = await adminDb().from("leads").delete().eq("id", leadId);
  if (res.error) throw new HttpError(500, "Could not remove that person");
  return await listLeads();
}

// GET /admin/reviews -> { reviews: [{id, name, service, rating, body, status, ts}] }
// Every review, pending first — ordered in SQL, BEFORE the limit, so pending
// rows can never be pushed out of the window by a pile of approved or hidden
// ones ('pending' > 'hidden' > 'approved' descending, conveniently).
async function listReviews(): Promise<Response> {
  const res = await adminDb()
    .from("reviews")
    .select("id, name, service, rating, body, status, source, created_at")
    .order("status", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(300);
  if (res.error) throw new HttpError(500, "Could not load reviews");
  const rows = (res.data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    service: r.service,
    rating: r.rating,
    body: r.body,
    status: r.status,
    source: r.source,
    ts: r.created_at,
  }));
  return json({ reviews: rows });
}

// POST /admin/reviews/:id/status { status: approved|hidden|pending } -> { review }
async function setReviewStatus(req: Request, reviewId: string): Promise<Response> {
  const body = await readJson(req);
  const status = String(body.status ?? "");
  if (!["approved", "hidden", "pending"].includes(status)) {
    throw new HttpError(400, "status must be approved, hidden, or pending");
  }
  const res = await adminDb()
    .from("reviews")
    .update({ status })
    .eq("id", reviewId)
    .select("id, name, service, rating, body, status, source, created_at")
    .maybeSingle();
  if (res.error) throw new HttpError(500, "Could not update that review");
  if (!res.data) throw new HttpError(404, "Review not found");
  const r = res.data;
  return json({
    review: {
      id: r.id,
      name: r.name,
      service: r.service,
      rating: r.rating,
      body: r.body,
      status: r.status,
      source: r.source,
      ts: r.created_at,
    },
  });
}

// POST /admin/broadcast { subject, message, image?, include_leads? }
//   -> { sent, image_url? }
//
// One message to every client, with an optional flyer. A flyer on its own is
// a valid send: sometimes the picture IS the message. With include_leads the
// waitlist gets it too, minus anyone who is already a client, so nobody hears
// the same message twice.
async function broadcast(req: Request): Promise<Response> {
  const body = await readJson(req);
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const image = typeof body.image === "string" ? body.image.trim() : "";
  const includeLeads = body.include_leads === true;
  if (!subject && !message && !image) {
    throw new HttpError(400, "Add a subject, a message, or a flyer before you send.");
  }

  // EVERYTHING that can fail happens BEFORE anyone is messaged: the flyer
  // upload, the clients load, and the waitlist load. A failure here gives her
  // one plain error with nobody contacted, so pressing Send again is always
  // safe. Failing between the two lists would leave the composer loaded after
  // a partial send — one more tap and every client gets the message twice.
  const imageUrl = image ? await storeFlyer(image) : null;

  const db = adminDb();
  const clientsRes = await db.from("clients").select("id, email, name, phone").eq("is_admin", false);
  if (clientsRes.error) throw new HttpError(500, "Could not load clients");

  const clients = clientsRes.data ?? [];
  const clientEmails = new Set(clients.map((c) => String(c.email ?? "").toLowerCase()));
  const leads: Array<{ name: string; email: string; phone: string | null }> = [];
  if (includeLeads) {
    const leadsRes = await db.from("leads").select("name, email, phone");
    if (leadsRes.error) throw new HttpError(500, "Could not load your waitlist. Nothing was sent.");
    for (const lead of leadsRes.data ?? []) {
      const email = String(lead.email ?? "").toLowerCase();
      if (!email || clientEmails.has(email)) continue;
      leads.push({ name: lead.name, email: lead.email, phone: lead.phone ?? null });
    }
  }

  let sent = 0;
  for (const client of clients) {
    await notifyBroadcast(client, subject, message, imageUrl);
    sent += 1;
  }
  for (const lead of leads) {
    await notifyBroadcast({ id: null, ...lead }, subject, message, imageUrl);
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
