// Client booking endpoints: GET /services, GET /hours, GET /availability,
// POST /bookings, POST /bookings/:id/pay-balance.
// Booking rules per ARCHITECTURE.md: 30 min slot step, a service blocks its
// full duration, last start = close - duration, one client at a time, blocked
// days remove the whole day. All times are America/Chicago.
//
// The open and close times themselves are NOT in this file. They live in the
// public.hours table and she edits them from her dashboard, so a day she
// closes stops being offered here the moment she saves it.

import { requireClient } from "../_shared/auth.ts";
import { parsePriceCents, SERVICES_BY_ID, servicesPayload } from "../_shared/catalog.ts";
import { adminDb } from "../_shared/db.ts";
import { chicagoNow, hhmmToMin, minToHhmm, readDayHours, readHours } from "../_shared/hours.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";
import { balanceCentsFor, withMoney } from "../_shared/money.ts";
import { notifyBookingCreated, notifyBookingRequest } from "../_shared/notify.ts";
import { getStripe } from "../_shared/stripe.ts";

const SLOT_STEP_MIN = 30;

interface Availability {
  date: string;
  closed: boolean;
  blocked: boolean;
  slots: string[];
}

async function availabilityFor(serviceId: string, date: string): Promise<Availability> {
  const service = SERVICES_BY_ID.get(serviceId);
  if (!service) throw new HttpError(404, "Unknown service");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");

  // Weekday of the calendar date (timezone-safe: UTC midnight of that date).
  const weekday = new Date(date + "T00:00:00Z").getUTCDay();
  const hours = await readDayHours(weekday);
  if (hours.closed || !hours.open || !hours.close) {
    return { date, closed: true, blocked: false, slots: [] };
  }

  const db = adminDb();
  const blockedRes = await db.from("blocked_days").select("date").eq("date", date).maybeSingle();
  if (blockedRes.error) throw new HttpError(500, "Could not check availability");
  if (blockedRes.data) return { date, closed: false, blocked: true, slots: [] };

  const bookedRes = await db
    .from("bookings")
    .select("time, duration_min")
    .eq("date", date)
    .neq("status", "canceled");
  if (bookedRes.error) throw new HttpError(500, "Could not check availability");
  const booked = (bookedRes.data ?? []).map((b) => {
    const start = hhmmToMin(b.time as string);
    return { start, end: start + (b.duration_min as number) };
  });

  const now = chicagoNow();
  if (date < now.date) return { date, closed: false, blocked: false, slots: [] };

  const open = hhmmToMin(hours.open);
  const close = hhmmToMin(hours.close);
  const slots: string[] = [];
  for (let start = open; start + service.duration_min <= close; start += SLOT_STEP_MIN) {
    if (date === now.date && start <= now.minutes) continue;
    const end = start + service.duration_min;
    const overlaps = booked.some((b) => start < b.end && b.start < end);
    if (!overlaps) slots.push(minToHhmm(start));
  }
  return { date, closed: false, blocked: false, slots };
}

export function handleServices(): Response {
  return json(servicesPayload());
}

// GET /api/hours (public). The public site prints this, so it is the same
// record the availability engine above reads. Nothing here is secret: these
// are the hours she wants the world to see.
export async function handleHours(): Promise<Response> {
  return json({ days: await readHours() });
}

export async function handleAvailability(url: URL): Promise<Response> {
  const serviceId = url.searchParams.get("service_id") ?? "";
  const date = url.searchParams.get("date") ?? "";
  if (!serviceId || !date) throw new HttpError(400, "service_id and date are required");
  return json(await availabilityFor(serviceId, date));
}

export async function handleCreateBooking(req: Request): Promise<Response> {
  const client = await requireClient(req);
  const body = await readJson(req);
  const serviceId = String(body.service_id ?? "");
  const date = String(body.date ?? "");
  const time = String(body.time ?? "");
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 1000) : "";

  const service = SERVICES_BY_ID.get(serviceId);
  if (!service) throw new HttpError(400, "Unknown service");
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    throw new HttpError(400, "time must be HH:MM");
  }

  // Friendly first pass: re-check availability at create time so the common
  // case gets a clear message. The real guarantee is the bookings_overlap
  // exclusion constraint in supabase/schema.sql; if two requests race past
  // this check, the second insert fails below with SQLSTATE 23P01.
  const avail = await availabilityFor(serviceId, date);
  if (avail.closed) throw new HttpError(409, "The salon is closed that day");
  if (avail.blocked) throw new HttpError(409, "That day is unavailable");
  if (!avail.slots.includes(time)) {
    throw new HttpError(409, "That time was just taken. Pick another slot");
  }

  const db = adminDb();
  const insert = await db
    .from("bookings")
    .insert({
      client_id: client.id,
      client_name: client.name,
      client_email: client.email,
      client_phone: client.phone,
      service_id: service.service_id,
      service_name: service.name,
      price: service.price,
      deposit_cents: service.deposit_cents,
      date,
      time,
      duration_min: service.duration_min,
      status: service.deposit_cents ? "awaiting_deposit" : "request",
      notes,
    })
    .select("*")
    .single();
  if (insert.error) {
    // 23P01 = exclusion violation from bookings_overlap: someone grabbed an
    // overlapping slot between the availability check and this insert.
    if ((insert.error as { code?: string }).code === "23P01") {
      throw new HttpError(409, "That time was just taken. Pick another slot");
    }
    throw new HttpError(500, "Could not create the booking");
  }
  let booking = insert.data;

  let checkoutUrl: string | null = null;
  if (service.deposit_cents) {
    const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
    // Some services charge the full price up front ("paid in full" note).
    // Do not label those a "deposit" on the Stripe checkout page.
    const priceCents = parsePriceCents(service.price);
    const paidInFull = priceCents != null && service.deposit_cents >= priceCents;
    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: client.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: service.deposit_cents,
              product_data: {
                name: paidInFull ? `${service.name} (paid in full)` : `${service.name} deposit`,
                description: `${booking.date} at ${booking.time} with Ebony at Sitting Pretty`,
              },
            },
          },
        ],
        // kind tells the webhook which half of the money model this session is.
        metadata: { booking_id: booking.id, kind: "deposit" },
        success_url: `${siteUrl}/?booking=${booking.id}&paid=1`,
        cancel_url: `${siteUrl}/?booking=${booking.id}&paid=0`,
      });
      const update = await db
        .from("bookings")
        .update({ stripe_session_id: session.id })
        .eq("id", booking.id)
        .select("*")
        .single();
      if (!update.error) booking = update.data;
      checkoutUrl = session.url;
    } catch (err) {
      // Do not leave an unpayable awaiting_deposit row behind.
      await db.from("bookings").delete().eq("id", booking.id);
      throw err instanceof HttpError
        ? err
        : new HttpError(500, "Could not start the deposit checkout. Try again");
    }
    await notifyBookingCreated(booking, checkoutUrl ?? "");
  } else {
    await notifyBookingRequest(booking);
  }

  return json({ booking: withMoney(booking), checkout_url: checkoutUrl });
}

// POST /api/bookings/:id/pay-balance (auth; owner or admin)
// -> { checkout_url, amount_cents }
//
// The client would rather settle the rest online than in the chair. Rules and
// wording mirror the demo route in server/server.mjs:
//  - a cancelled appointment takes no money at all
//  - the deposit comes first, it is what holds the time
//  - nothing to charge when it is already paid in full
//  - a variable price ("$50+") has no fixed number, so it is never charged
//    online; Ebony settles that one in person
export async function handlePayBalance(req: Request, bookingId: string): Promise<Response> {
  const client = await requireClient(req);
  const db = adminDb();

  const found = await db.from("bookings").select("*").eq("id", bookingId).maybeSingle();
  if (found.error) throw new HttpError(500, "Could not load the booking");
  const booking = found.data;
  if (!booking) throw new HttpError(404, "Booking not found");
  if (booking.client_id !== client.id && !client.is_admin) {
    throw new HttpError(403, "Not your booking");
  }
  if (booking.status === "canceled") throw new HttpError(409, "That appointment was cancelled.");
  if (booking.status === "awaiting_deposit") {
    throw new HttpError(409, "Pay the deposit first, then the rest can be paid any time.");
  }
  if (booking.paid_in_full) throw new HttpError(409, "This one is already paid in full.");

  const balance = balanceCentsFor(booking);
  if (balance == null) {
    throw new HttpError(
      409,
      "The final amount for this service depends on your hair, so Ebony settles it with you in person.",
    );
  }

  const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: booking.client_email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: balance,
          product_data: {
            name: `${booking.service_name} balance`,
            description: `${booking.date} at ${booking.time} with Ebony at Sitting Pretty`,
          },
        },
      },
    ],
    // kind=balance is what makes the webhook apply this as a balance payment
    // instead of a deposit.
    metadata: { booking_id: booking.id, kind: "balance" },
    success_url: `${siteUrl}/?booking=${booking.id}&paid=1`,
    cancel_url: `${siteUrl}/?booking=${booking.id}&paid=0`,
  });

  // Recorded so the webhook can tell a replay of this session from a second,
  // genuinely duplicate payment. The money still lands if this write fails,
  // and the webhook verifies the amount either way, so do not fail the call.
  const stored = await db
    .from("bookings")
    .update({ balance_session_id: session.id })
    .eq("id", booking.id);
  if (stored.error) {
    console.error(`Could not store balance_session_id for ${booking.id}:`, stored.error.message);
  }

  return json({ checkout_url: session.url, amount_cents: balance });
}
