// Slot alerts: "want this time if it frees up." Contract: API.md "Slot alerts".
//
// A client taps a taken chip in the booking sheet and leaves an email (or is
// already signed in). When a cancellation frees that time, notifySlotOpened
// (called from cancel.ts) emails everyone waiting inside the freed window.
// First to book wins; nothing is held.
//
// POST /slot-alerts is the second public write in the API after /leads, so it
// borrows that endpoint's whole posture: per-IP throttle, honeypot field, and
// the same answer for a duplicate as for a fresh row so the endpoint cannot be
// used to probe who is waiting on which day.

import { requireClientMaybe } from "../_shared/auth.ts";
import { adminDb } from "../_shared/db.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const BUCKET = new Map<string, { count: number; reset: number }>();
const LIMIT = 6; // per IP per minute
function throttle(req: Request): void {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const b = BUCKET.get(ip);
  if (!b || now > b.reset) {
    BUCKET.set(ip, { count: 1, reset: now + 60_000 });
    return;
  }
  b.count += 1;
  if (b.count > LIMIT) {
    throw new HttpError(429, "Too many tries. Please wait a minute and try again.");
  }
  if (BUCKET.size > 5000) {
    for (const [k, v] of BUCKET) if (now > v.reset) BUCKET.delete(k);
  }
}

// POST /slot-alerts { day, time, email?, company? } -> { ok: true }
// Signed-in clients need no email: the one on their account is used, and the
// alert is tied to them so it survives an email typo. Guests type one.
export async function handleCreateSlotAlert(req: Request): Promise<Response> {
  throttle(req);
  const body = await readJson(req);

  // Honeypot, same field name as the popup so bots that learned one form
  // stuff the other: any value at all is a bot, which gets a cheerful yes.
  if (body.company != null && String(body.company).trim() !== "") return json({ ok: true });

  const day = typeof body.day === "string" ? body.day.trim() : "";
  const time = typeof body.time === "string" ? body.time.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "day must be YYYY-MM-DD");
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) throw new HttpError(400, "time must be HH:MM");

  // The duration of the service they were browsing. Bounded hard at her
  // longest real service (480 min): it only widens the sweep's overlap test,
  // and an absurd value would subscribe one address to every cancellation of
  // the day.
  const durRaw = Number(body.duration_min);
  const duration_min = Number.isInteger(durRaw) && durRaw >= 15 && durRaw <= 480 ? durRaw : 60;

  // Yesterday's slot cannot free up. Compare as strings: both are ISO dates.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  if (day < today) throw new HttpError(400, "That day has already passed.");

  const client = await requireClientMaybe(req);
  let email = client?.email ?? "";
  if (!email) {
    email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    // No session resolved AND no email in the body: the signed-in UI, which
    // never shows an email field, sent this after the session expired. An
    // email-format error would name a field that was never on screen.
    if (!email) throw new HttpError(401, "Your session expired. Sign in and try again.");
    if (!EMAIL_RE.test(email)) {
      throw new HttpError(400, "That email does not look right. Check it and try again.");
    }
  }

  // Nobody verifies a guest email, so bound what one address can ever be
  // sent: at most 5 pending alerts. Over the cap answers exactly like
  // success -- the same no-probe posture as a duplicate -- because the only
  // caller who ever hits it is a bot or an abuser enrolling someone else.
  const db = adminDb();
  const pending = await db
    .from("slot_alerts")
    .select("id", { count: "exact", head: true })
    .eq("email", email.toLowerCase())
    .is("notified_at", null);
  if (!pending.error && (pending.count ?? 0) >= 5) return json({ ok: true });

  // A fresh tap RE-ARMS a spent alert rather than being swallowed by the
  // unique index: "you got your email, someone beat you to it, you tapped
  // again" must mean you are waiting again. Update-first handles both the
  // spent row and the pending duplicate (pending rows just refresh their
  // duration); only a genuinely new (day, time, email) inserts.
  const lower = email.toLowerCase();
  const upd = await db
    .from("slot_alerts")
    .update({ notified_at: null, duration_min, client_id: client?.id ?? null })
    .eq("day", day).eq("time", time).eq("email", lower)
    .select("id");
  if (upd.error) {
    console.error("slot_alerts re-arm failed:", upd.error.message);
    throw new HttpError(500, "Could not save that. Try again in a second.");
  }
  if ((upd.data ?? []).length) return json({ ok: true });

  const res = await db.from("slot_alerts").insert(
    { day, time, duration_min, email: lower, client_id: client?.id ?? null },
  );
  // 23505: two first taps raced; either way the row exists and is pending.
  if (res.error && res.error.code !== "23505") {
    console.error("slot_alerts insert failed:", res.error.message);
    throw new HttpError(500, "Could not save that. Try again in a second.");
  }
  return json({ ok: true });
}
