// Leads (the popup's waitlist) and reviews. Contract: API.md "Leads & Reviews".
//
// POST /leads is the one public write in the whole API, so it is strict about
// what it accepts and quiet about what it knows: a duplicate email answers
// exactly like a fresh one, so nobody can use the popup to probe who is on
// Ebony's list.

import { requireClient } from "../_shared/auth.ts";
import { adminDb } from "../_shared/db.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Per-IP throttle for the public write. In-memory per isolate, so it resets
// on cold starts — that is fine: its job is to make bulk stuffing (thousands
// of garbage rows that Ebony would later pay Twilio/Resend to message) cost
// more than it is worth, not to be a perfect wall.
const LEAD_BUCKET = new Map<string, { count: number; reset: number }>();
const LEAD_LIMIT = 6; // per IP per minute — a human never hits this
function throttleLead(req: Request): void {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const b = LEAD_BUCKET.get(ip);
  if (!b || now > b.reset) {
    LEAD_BUCKET.set(ip, { count: 1, reset: now + 60_000 });
    return;
  }
  b.count += 1;
  if (b.count > LEAD_LIMIT) {
    throw new HttpError(429, "Too many tries. Please wait a minute and try again.");
  }
  // Keep the map from growing without bound on a long-lived isolate.
  if (LEAD_BUCKET.size > 5000) {
    for (const [k, v] of LEAD_BUCKET) if (now > v.reset) LEAD_BUCKET.delete(k);
  }
}

// POST /leads { name, email, phone?, source? } -> { ok: true }
export async function handleCreateLead(req: Request): Promise<Response> {
  throttleLead(req);
  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  const rawPhone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  const source = typeof body.source === "string" && body.source.trim()
    ? body.source.trim().slice(0, 40)
    : "popup";
  // The popup renders this field invisibly and no person ever fills it.
  // ANY non-empty value — string or not — is a bot, which gets a cheerful
  // yes and no database row.
  if (body.company != null && String(body.company).trim() !== "") return json({ ok: true });
  if (name.length < 2) throw new HttpError(400, "Tell us your name so Ebony knows who you are.");
  if (!EMAIL_RE.test(email)) {
    throw new HttpError(400, "That email does not look right. Check it and try again.");
  }
  // Phone is optional, but a phone that cannot be texted is worse than none:
  // it would sit on her list and waste a Twilio call on every broadcast.
  let phone = "";
  if (rawPhone) {
    const digits = rawPhone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      throw new HttpError(400, "That phone number does not look right. Check it, or leave it blank.");
    }
    phone = rawPhone;
  }

  const db = adminDb();
  const res = await db.from("leads").upsert(
    { name, email, ...(phone ? { phone } : {}), source },
    { onConflict: "email", ignoreDuplicates: true },
  );
  // A duplicate is success from where the visitor stands: they are on the list.
  if (res.error && res.error.code !== "23505") {
    console.error("leads insert failed:", res.error.message);
    throw new HttpError(500, "Could not save that. Try again in a second.");
  }
  return json({ ok: true });
}

// The public wall prints "Tasha R.", not a full legal name: reviewers are
// clients, not public figures. Ebony sees the full name in her dashboard.
function publicName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// GET /reviews -> { reviews: [{name, service, rating, body, ts}], count }
// Approved only, newest first. There is deliberately NO row-level read policy
// on the table, so this projection is the only way approved reviews reach the
// public — client_id and status never leave the database.
export async function handleListReviews(): Promise<Response> {
  const res = await adminDb()
    .from("reviews")
    .select("name, service, rating, body, created_at")
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(60);
  if (res.error) throw new HttpError(500, "Could not load reviews");
  const reviews = (res.data ?? []).map((r) => ({
    name: publicName(r.name as string),
    service: r.service,
    rating: r.rating,
    body: r.body,
    ts: r.created_at,
  }));
  return json({ reviews, count: reviews.length });
}

// POST /reviews { rating, body, service? } -> { ok: true }
// Signed-in clients only. The name comes from their profile, never the
// request. One review per client, latest wins, and every save goes back to
// pending until Ebony approves it — so an edited review is re-read too, and
// a hostile account can hold exactly one seat in her moderation queue.
export async function handleCreateReview(req: Request): Promise<Response> {
  const client = await requireClient(req);
  const payload = await readJson(req);
  const rating = Number(payload.rating);
  const text = typeof payload.body === "string" ? payload.body.trim().slice(0, 1200) : "";
  const service = typeof payload.service === "string" ? payload.service.trim().slice(0, 120) : "";
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new HttpError(400, "Pick a star rating from 1 to 5.");
  }
  if (text.length < 5) throw new HttpError(400, "Tell us a little about your visit first.");

  const res = await adminDb().from("reviews").upsert({
    client_id: client.id,
    name: client.name || client.email.split("@")[0],
    service,
    rating,
    body: text,
    status: "pending",
    // Refreshed on every save so an updated review sorts as new, both in her
    // moderation queue and on the wall once she approves it.
    created_at: new Date().toISOString(),
  }, { onConflict: "client_id" });
  if (res.error) {
    console.error("reviews upsert failed:", res.error.message);
    throw new HttpError(500, "Could not save your review. Try again in a second.");
  }
  return json({ ok: true });
}
