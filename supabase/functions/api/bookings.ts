// Client booking endpoints: GET /services, GET /availability, POST /bookings.
// Booking rules per ARCHITECTURE.md: Sun closed, Mon-Fri 09:00-20:00,
// Sat 09:00-18:00, 30 min slot step, a service blocks its full duration,
// last start = close - duration, one client at a time, blocked days remove
// the whole day. All times are America/Chicago.

import { requireClient } from "../_shared/auth.ts";
import { parsePriceCents, SERVICES_BY_ID, servicesPayload } from "../_shared/catalog.ts";
import { adminDb } from "../_shared/db.ts";
import { HttpError, json, readJson } from "../_shared/http.ts";
import { notifyBookingCreated, notifyBookingRequest } from "../_shared/notify.ts";
import { getStripe } from "../_shared/stripe.ts";

const SLOT_STEP_MIN = 30;

// Open minutes per weekday (0 = Sunday). null = closed.
const HOURS: Record<number, [number, number] | null> = {
  0: null,
  1: [9 * 60, 20 * 60],
  2: [9 * 60, 20 * 60],
  3: [9 * 60, 20 * 60],
  4: [9 * 60, 20 * 60],
  5: [9 * 60, 20 * 60],
  6: [9 * 60, 18 * 60],
};

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

function minToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// Current date + minutes-since-midnight in America/Chicago, so "today"
// filtering matches salon time no matter where the edge function runs.
function chicagoNow(): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
  };
}

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
  const hours = HOURS[weekday];
  if (!hours) return { date, closed: true, blocked: false, slots: [] };

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

  const [open, close] = hours;
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
        metadata: { booking_id: booking.id },
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

  return json({ booking, checkout_url: checkoutUrl });
}
