// Client booking endpoints: GET /services, GET /hours, GET /availability,
// POST /bookings, POST /holds/:id/refresh, POST /bookings/:id/pay-balance.
// Booking rules per ARCHITECTURE.md: 30 min slot step, a service blocks its
// full duration, last start = close - duration, one client at a time, blocked
// days remove the whole day. All times are America/Chicago.
//
// THE DEPOSIT IS WHAT BOOKS THE SPOT. A service with a published deposit does
// not create an appointment here: it creates a hold and a Stripe Checkout
// session, and the appointment appears when the money clears. See
// _shared/holds.ts and the hold branch of createBooking below.
//
// The open and close times themselves are NOT in this file. They live in the
// public.hours table and she edits them from her dashboard, so a day she
// closes stops being offered here the moment she saves it.

import { requireClient } from "../_shared/auth.ts";
import { parsePriceCents, SERVICES_BY_ID, servicesPayload } from "../_shared/catalog.ts";
import { adminDb } from "../_shared/db.ts";
import { activeHolds, holdExpiry, type HoldRow, sweepExpiredHolds } from "../_shared/holds.ts";
import { chicagoNow, hhmmToMin, minToHhmm, readDayHours, readHours } from "../_shared/hours.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";
import { balanceCentsFor, withMoney } from "../_shared/money.ts";
import { notifyBookingRequest, notifyOwnerBookingRequest } from "../_shared/notify.ts";
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

  // A slot is taken by an appointment OR by someone who is paying for it right
  // this minute. Without counting live holds, two people could both reach
  // Stripe for the same time and only one of them could be given it. Holds
  // that have already run out are excluded by the query, so an abandoned
  // checkout stops blocking the time the moment it expires.
  let held: Array<{ time: string; duration_min: number }>;
  try {
    held = await activeHolds(date);
  } catch (err) {
    console.error("Could not read holds for", date, err);
    throw new HttpError(500, "Could not check availability");
  }

  const booked = [...(bookedRes.data ?? []), ...held].map((b) => {
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
  // case gets a clear message. The real guarantee is in the database
  // (bookings_overlap, holds_overlap and the sp_slot_guard trigger in
  // supabase/schema.sql); if two requests race past this check, the second
  // write fails below with SQLSTATE 23P01.
  const avail = await availabilityFor(serviceId, date);
  if (avail.closed) throw new HttpError(409, "The salon is closed that day");
  if (avail.blocked) throw new HttpError(409, "That day is unavailable");
  if (!avail.slots.includes(time)) {
    throw new HttpError(409, "That time was just taken. Pick another slot");
  }

  // A published deposit means the deposit is what books the spot, so hold the
  // time and send her to checkout. Nothing goes on the calendar yet.
  if (service.deposit_cents) {
    return await createHold(client, service, date, time, notes);
  }

  // No published deposit means there is nothing to charge up front, so this
  // stays a request for Ebony to confirm by text.
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
      status: "request",
      notes,
    })
    .select("*")
    .single();
  if (insert.error) {
    // 23P01 = exclusion violation: someone grabbed an overlapping slot, or
    // started paying for it, between the availability check and this insert.
    if ((insert.error as { code?: string }).code === "23P01") {
      throw new HttpError(409, "That time was just taken. Pick another slot");
    }
    throw new HttpError(500, "Could not create the booking");
  }
  const booking = insert.data;

  await notifyBookingRequest(booking);
  await notifyOwnerBookingRequest(booking);

  return json({ booking: withMoney(booking) });
}

// The deposit-first path. The slot is claimed in the holds table FIRST, so the
// time cannot be sold twice while she is on the Stripe page, and the
// appointment only comes into existence when the webhook sees the money
// (functions/api/stripe-webhook.ts). If she abandons checkout the hold expires
// and the slot is free again in minutes, instead of an unpaid appointment
// sitting on a Saturday for a day.
async function createHold(
  client: { id: string; email: string; name: string | null; phone: string | null },
  service: {
    service_id: string;
    name: string;
    price: string;
    duration_min: number;
    deposit_cents: number | null;
  },
  date: string,
  time: string,
  notes: string,
): Promise<Response> {
  const db = adminDb();
  const depositCents = service.deposit_cents as number;

  const claim = await db
    .from("holds")
    .insert({
      client_id: client.id,
      service_id: service.service_id,
      service_name: service.name,
      price: service.price,
      deposit_cents: depositCents,
      date,
      time,
      duration_min: service.duration_min,
      notes,
      expires_at: holdExpiry(),
    })
    .select("*")
    .single();
  if (claim.error) {
    if ((claim.error as { code?: string }).code === "23P01") {
      throw new HttpError(409, "That time was just taken. Pick another slot");
    }
    console.error("Could not hold the slot:", claim.error.message);
    throw new HttpError(500, "Could not hold that time. Try again");
  }
  let hold = claim.data as HoldRow;

  const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
  // Some services charge the full price up front ("paid in full" note).
  // Do not label those a "deposit" on the Stripe checkout page.
  const priceCents = parsePriceCents(service.price);
  const paidInFull = priceCents != null && depositCents >= priceCents;

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
            unit_amount: depositCents,
            product_data: {
              name: paidInFull ? `${service.name} (paid in full)` : `${service.name} deposit`,
              description: `${date} at ${time} with Ebony at Sitting Pretty`,
            },
          },
        },
      ],
      // hold_id is what the webhook turns into an appointment. kind tells it
      // which half of the money model this session is; sessions created before
      // the hold model carry booking_id instead and still work.
      metadata: { hold_id: hold.id, kind: "deposit" },
      success_url: `${siteUrl}/?hold=${hold.id}&paid=1`,
      cancel_url: `${siteUrl}/?hold=${hold.id}&paid=0`,
    });

    // No page to pay on means this hold could never become an appointment,
    // and the frontend would read a missing checkout_url as "no payment
    // needed" and tell her she is booked. Fail instead, and free the slot.
    if (!session.url) throw new HttpError(502, "Could not start the deposit checkout. Try again");

    const stored = await db
      .from("holds")
      .update({ stripe_session_id: session.id })
      .eq("id", hold.id)
      .select("*")
      .maybeSingle();
    if (stored.data) hold = stored.data as HoldRow;

    return json({ hold, checkout_url: session.url });
  } catch (err) {
    // No checkout page means she can never pay for this hold, so do not let it
    // sit on the slot for the next quarter of an hour.
    await db.from("holds").delete().eq("id", hold.id);
    throw err instanceof HttpError
      ? err
      : new HttpError(500, "Could not start the deposit checkout. Try again");
  }
}

// POST /api/holds/:id/refresh (auth, owner) -> { hold }
//
// She is still on the checkout page and the clock is running low. Push the
// expiry back out so she is not thrown off a time she is in the middle of
// paying for. An expired hold is refused with 410 rather than quietly revived:
// by then the slot may already belong to somebody else, and the UI sends her
// back to pick a new time.
export async function handleRefreshHold(req: Request, holdId: string): Promise<Response> {
  const client = await requireClient(req);
  await sweepExpiredHolds();

  const db = adminDb();
  // One extension only. A hold blocks the slot exactly like a booking does, so
  // refreshing without limit would let somebody sit on a Saturday for free and
  // look identical to a paid appointment to everyone else.
  const refreshed = await db
    .from("holds")
    .update({ expires_at: holdExpiry(), refresh_count: 1 })
    .eq("id", holdId)
    .eq("client_id", client.id)
    .eq("refresh_count", 0)
    .gt("expires_at", new Date().toISOString())
    .select("*")
    .maybeSingle();
  if (refreshed.error) throw new HttpError(500, "Could not hold that time any longer");
  if (!refreshed.data) {
    throw new HttpError(
      410,
      "That time is no longer being held for you. Please pick a time again.",
    );
  }
  return json({ hold: refreshed.data });
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
