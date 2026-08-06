// POST /api/stripe/webhook
//
// Signature-verified Stripe webhook. checkout.session.completed carries
// metadata that says which half of the money model just landed:
//
//   kind=balance   the rest of a fixed price, paid online after the deposit:
//                  adds to paid_cents and marks the booking paid in full.
//   hold_id        THE DEPOSIT THAT BOOKS THE SPOT. The appointment does not
//                  exist yet: this is where the hold becomes a confirmed
//                  booking, with deposit_paid_at set and the deposit in
//                  paid_cents, and where the hold is deleted.
//   booking_id     a deposit for an appointment created before the hold model
//                  (status awaiting_deposit): awaiting_deposit -> confirmed.
//                  Sessions predating metadata.kind take this path too, which
//                  is what they are.
//
// Protections, in order, for every kind:
//   1. the Stripe signature must verify, or nothing here runs
//   2. payment_status must be "paid" (async methods complete before the money
//      settles), so no state ever moves on money that has not landed
//   3. the amount charged must equal what was expected FOR THAT KIND: the
//      deposit_cents for a deposit, the computed balance for a balance. Any
//      mismatch is logged and nothing is created or changed.
//   4. idempotent: every write is filtered on the state it is transitioning
//      out of (and the hold is deleted by the same statement that reads it),
//      so replays and concurrent deliveries cannot double-apply.
//   5. when money lands on something that is not taking any (a cancelled or
//      settled booking, a second payment, a hold that already ran out),
//      nothing is created or changed and Ebony gets an alert so she can refund
//      it in Stripe. Replays of a session that was already applied are silent,
//      so the alert always means something.
//
// Endpoint setup: RUNBOOK step 4.

import type Stripe from "npm:stripe@17";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

import { adminDb } from "../_shared/db.ts";
import { type HoldRow } from "../_shared/holds.ts";
import { errorResponse, json } from "../_shared/http.ts";
import { balanceCentsFor, isPaidInFullAfter, paidCents } from "../_shared/money.ts";
import {
  notifyBalancePaid,
  notifyBookingConfirmed,
  notifyHoldExpiredRefund,
  notifyOwnerBalancePaid,
  notifyOwnerNewBooking,
  notifyPaymentNeedsRefund,
} from "../_shared/notify.ts";
import { getStripe, stripeCryptoProvider } from "../_shared/stripe.ts";

// deno-lint-ignore no-explicit-any
type BookingRow = any;

export async function handleStripeWebhook(req: Request): Promise<Response> {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return errorResponse(503, "Webhook secret not configured");

  const signature = req.headers.get("stripe-signature");
  if (!signature) return errorResponse(400, "Missing stripe-signature header");

  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(
      payload,
      signature,
      secret,
      undefined,
      stripeCryptoProvider,
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return errorResponse(400, "Invalid signature");
  }

  if (event.type !== "checkout.session.completed") return json({ received: true });

  const session = event.data.object as Stripe.Checkout.Session;

  // checkout.session.completed can fire before the money settles (async
  // payment methods report payment_status "unpaid"). Nothing below this line
  // runs, and no alert is raised, until Stripe says the session is paid.
  if (session.payment_status !== "paid") {
    console.error(
      `Webhook: session ${session.id} completed but payment_status=` +
        `${session.payment_status}; nothing changed`,
    );
    return json({ received: true });
  }

  const db = adminDb();
  const kind = session.metadata?.kind === "balance" ? "balance" : "deposit";

  // A deposit against a hold: the appointment is created here, not before.
  if (kind !== "balance") {
    const holdId = session.metadata?.hold_id;
    if (holdId) return await applyHoldDeposit(db, session, holdId);
  }

  const bookingId = session.metadata?.booking_id;
  const found = bookingId
    ? await db.from("bookings").select("*").eq("id", bookingId).maybeSingle()
    : kind === "balance"
    ? await db.from("bookings").select("*").eq("balance_session_id", session.id).maybeSingle()
    : await db.from("bookings").select("*").eq("stripe_session_id", session.id).maybeSingle();
  if (found.error) return errorResponse(500, "Could not load the booking");
  const booking = found.data;

  if (!booking) {
    // A deposit session with no booking may still be a hold whose metadata did
    // not carry hold_id (or a hold that was already booked). Look it up the
    // same way before deciding nothing happened.
    if (kind !== "balance") return await applyHoldDeposit(db, session, null);
    console.error(`Webhook: no booking matches session ${session.id}; acknowledged, no action`);
    return json({ received: true });
  }

  return kind === "balance"
    ? await applyBalance(db, session, booking)
    : await applyDeposit(db, session, booking);
}

// The deposit that books the spot. Turns a live hold into a confirmed
// appointment, in one database transaction (sp_book_hold in schema.sql) so the
// slot can never be claimed twice and the hold can never survive the booking.
async function applyHoldDeposit(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  holdId: string | null,
): Promise<Response> {
  // Idempotency, first thing: a replay of a delivery that already booked this
  // hold changes nothing and says nothing.
  const already = await db
    .from("bookings")
    .select("id")
    .eq("stripe_session_id", session.id)
    .maybeSingle();
  if (already.error) return errorResponse(500, "Could not check the booking");
  if (already.data) return json({ received: true });

  const lookup = holdId
    ? await db.from("holds").select("*").eq("id", holdId).maybeSingle()
    : await db.from("holds").select("*").eq("stripe_session_id", session.id).maybeSingle();
  if (lookup.error) return errorResponse(500, "Could not load the held time");
  const hold = lookup.data as HoldRow | null;

  if (!hold && !holdId) {
    console.error(`Webhook: no booking or hold matches session ${session.id}; no action`);
    return json({ received: true });
  }

  // The session must have charged exactly the deposit that was quoted for this
  // slot. On any mismatch, log it and create nothing.
  if (hold && session.amount_total !== hold.deposit_cents) {
    console.error(
      `Webhook: amount mismatch for hold ${hold.id}: session ${session.id} ` +
        `amount_total=${session.amount_total}, expected deposit_cents=` +
        `${hold.deposit_cents}; NOT booking it`,
    );
    return json({ received: true });
  }

  const amount = session.amount_total ?? hold?.deposit_cents ?? 0;
  const booked = hold
    ? await db.rpc("sp_book_hold", {
      p_hold_id: hold.id,
      p_session_id: session.id,
      p_amount_cents: amount,
      // The money rules live in _shared/money.ts and nowhere else, so a
      // service that charges its whole price up front is settled already.
      p_paid_in_full: isPaidInFullAfter({ price: hold.price, paid_cents: 0 }, amount),
    })
    : { data: null, error: null };
  if (booked.error) {
    console.error(`Webhook: could not book hold ${hold?.id}:`, booked.error.message);
    return errorResponse(500, "Could not confirm the booking");
  }
  const row = Array.isArray(booked.data) ? booked.data[0] : booked.data;
  // sp_book_hold returns SQL NULL when the hold is gone or expired. A function
  // returning a NULL composite is expanded by Postgres into ONE row with every
  // column null, so `row` can be a truthy object that is entirely empty.
  // Testing the object itself would treat "nothing was booked" as success:
  // the client is charged, no appointment exists, and formatting the null time
  // throws on the way out, so the webhook 500s and Stripe retries it forever.
  // Test a column that a real row must have instead.
  const booking = (row && (row as BookingRow).id ? row : null) as BookingRow | null;

  if (booking) {
    const balance = balanceCentsFor(booking);
    await notifyBookingConfirmed(booking, balance);
    await notifyOwnerNewBooking(booking, balance);
    return json({ received: true });
  }

  // The hold had already run out (or a concurrent delivery took it). Check
  // once more for a booking from this session before raising an alarm, so a
  // race between two deliveries stays silent.
  const after = await db
    .from("bookings")
    .select("id")
    .eq("stripe_session_id", session.id)
    .maybeSingle();
  if (after.data) return json({ received: true });

  console.error(
    `Webhook: deposit paid for hold ${holdId ?? session.id} but the hold had expired; ` +
      `nothing was booked, flagging for refund`,
  );

  // Give her a name and a number to act on. The hold does not snapshot the
  // client the way a booking does, so read the profile it points at.
  interface Contact {
    name: string | null;
    email: string | null;
    phone: string | null;
  }
  let contact: Contact | null = null;
  if (hold) {
    const who = await db
      .from("clients")
      .select("name, email, phone")
      .eq("id", hold.client_id)
      .maybeSingle();
    if (who.data) contact = who.data as Contact;
  }

  // No appointment was invented out of an expired hold, and the client is
  // never told a refund is coming that has not happened. Ebony decides.
  await notifyHoldExpiredRefund({
    service_name: hold?.service_name ?? null,
    date: hold?.date ?? null,
    time: hold?.time ?? null,
    client_name: contact?.name ?? null,
    client_email: contact?.email ?? session.customer_details?.email ?? session.customer_email ??
      null,
    client_phone: contact?.phone ?? null,
    amount_cents: session.amount_total ?? null,
  });
  return json({ received: true });
}

async function applyDeposit(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  booking: BookingRow,
): Promise<Response> {
  if (booking.status !== "awaiting_deposit") {
    // A replay of the session that already confirmed this booking is expected
    // and silent. Anything else is money on an appointment that was not
    // waiting for a deposit, which only Ebony can sort out.
    const replay = booking.stripe_session_id === session.id && booking.deposit_paid_at != null;
    if (!replay) {
      console.error(
        `Webhook: deposit paid for booking ${booking.id} in status ${booking.status} ` +
          `(session ${session.id}); NOT changing it, flagging for refund`,
      );
      await notifyPaymentNeedsRefund(booking);
    }
    return json({ received: true });
  }

  // The session must have charged exactly this booking's deposit. On any
  // mismatch, log it and leave the booking untouched instead of confirming.
  if (session.amount_total !== booking.deposit_cents) {
    console.error(
      `Webhook: amount mismatch for booking ${booking.id}: session ${session.id} ` +
        `amount_total=${session.amount_total}, expected deposit_cents=` +
        `${booking.deposit_cents}; NOT confirming`,
    );
    return json({ received: true });
  }

  const paid = paidCents(booking) + (session.amount_total ?? 0);
  // Atomic transition: the status filter makes concurrent replays race
  // safely; only the delivery that actually flips the row sends the email.
  const updated = await db
    .from("bookings")
    .update({
      status: "confirmed",
      deposit_paid_at: new Date().toISOString(),
      paid_cents: paid,
      // A service that charges its whole price up front is settled already.
      paid_in_full: isPaidInFullAfter(booking, paid),
      stripe_session_id: booking.stripe_session_id ?? session.id,
    })
    .eq("id", booking.id)
    .eq("status", "awaiting_deposit")
    .select("*")
    .maybeSingle();
  if (updated.error) return errorResponse(500, "Could not confirm the booking");
  if (updated.data) {
    const balance = balanceCentsFor(updated.data);
    await notifyBookingConfirmed(updated.data, balance);
    // She finds out from her phone, not from opening the dashboard.
    await notifyOwnerNewBooking(updated.data, balance);
  }
  return json({ received: true });
}

async function applyBalance(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  booking: BookingRow,
): Promise<Response> {
  // A balance is only payable on an appointment that is still standing, whose
  // deposit already landed, and that is not settled yet.
  const payable = booking.status !== "canceled" &&
    booking.status !== "awaiting_deposit" &&
    !booking.paid_in_full;
  if (!payable) {
    // Was THIS money already taken in, or is this the first time it has
    // landed? balance_session_id is written when the checkout is created,
    // before any money moves, and marking a booking paid in person sets
    // paid_in_full on its own. Testing those two alone called a genuine
    // first payment a duplicate whenever she settled up in the chair while a
    // balance checkout was still open: the client is charged, nothing records
    // it, and she is never told to refund. Ask instead whether the amount is
    // already inside paid_cents.
    const charged = session.amount_total ?? 0;
    const alreadyTaken = booking.balance_session_id === session.id &&
      (booking.paid_cents ?? 0) >= charged &&
      charged > 0;
    if (!alreadyTaken) {
      console.error(
        `Webhook: balance paid for booking ${booking.id} (status ${booking.status}, ` +
          `paid_in_full=${booking.paid_in_full}, session ${session.id}); ` +
          `NOT changing it, flagging for refund`,
      );
      await notifyPaymentNeedsRefund(booking);
    }
    return json({ received: true });
  }

  // Expected amount for THIS kind: whatever was still owed. null means the
  // price is variable, which is never charged online, so this cannot be right.
  const expected = balanceCentsFor(booking);
  if (expected == null || session.amount_total !== expected) {
    console.error(
      `Webhook: balance amount mismatch for booking ${booking.id}: session ${session.id} ` +
        `amount_total=${session.amount_total}, expected balance=${expected}; NOT applying`,
    );
    return json({ received: true });
  }

  const paid = paidCents(booking) + expected;
  const updated = await db
    .from("bookings")
    .update({ paid_cents: paid, paid_in_full: true, balance_session_id: session.id })
    .eq("id", booking.id)
    .eq("paid_in_full", false)
    .select("*")
    .maybeSingle();
  if (updated.error) return errorResponse(500, "Could not record the balance payment");

  if (!updated.data) {
    // Another delivery settled the row first. Same session means a replay we
    // already applied; a different one means a second payment really landed.
    const after = await db.from("bookings").select("*").eq("id", booking.id).maybeSingle();
    const row = after.data;
    if (row && row.balance_session_id !== session.id) {
      console.error(
        `Webhook: booking ${booking.id} was already settled when balance session ` +
          `${session.id} arrived; flagging for refund`,
      );
      await notifyPaymentNeedsRefund(row);
    }
    return json({ received: true });
  }

  await notifyBalancePaid(updated.data);
  await notifyOwnerBalancePaid(updated.data, expected);
  return json({ received: true });
}
