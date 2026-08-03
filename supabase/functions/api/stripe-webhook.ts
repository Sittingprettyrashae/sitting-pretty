// POST /api/stripe/webhook
//
// Signature-verified Stripe webhook. checkout.session.completed carries
// metadata.kind, which says which half of the money model just landed:
//
//   kind=balance   the rest of a fixed price, paid online after the deposit:
//                  adds to paid_cents and marks the booking paid in full.
//   anything else  the deposit: awaiting_deposit -> confirmed, records
//                  deposit_paid_at, adds the deposit to paid_cents, and sends
//                  the confirmation. Sessions created before kind existed have
//                  no metadata.kind and take this path, which is what they are.
//
// Protections, in order, for both kinds:
//   1. the Stripe signature must verify, or nothing here runs
//   2. payment_status must be "paid" (async methods complete before the money
//      settles), so no state ever moves on money that has not landed
//   3. the amount charged must equal what was expected FOR THAT KIND: the
//      deposit_cents for a deposit, the computed balance for a balance. Any
//      mismatch is logged and the booking is left exactly as it was.
//   4. idempotent: the update is filtered on the state it is transitioning
//      out of, so replays and concurrent deliveries cannot double-apply.
//   5. when money lands on a booking that is not taking any (cancelled,
//      already settled, a second payment), nothing is changed and Ebony gets
//      an alert so she can refund it in Stripe. Replays of a session that was
//      already applied are silent, so the alert means something.
//
// Endpoint setup: RUNBOOK step 4.

import type Stripe from "npm:stripe@17";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

import { adminDb } from "../_shared/db.ts";
import { errorResponse, json } from "../_shared/http.ts";
import { balanceCentsFor, isPaidInFullAfter, paidCents } from "../_shared/money.ts";
import {
  notifyBalancePaid,
  notifyBookingConfirmed,
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
  const db = adminDb();
  const kind = session.metadata?.kind === "balance" ? "balance" : "deposit";

  const bookingId = session.metadata?.booking_id;
  const found = bookingId
    ? await db.from("bookings").select("*").eq("id", bookingId).maybeSingle()
    : kind === "balance"
    ? await db.from("bookings").select("*").eq("balance_session_id", session.id).maybeSingle()
    : await db.from("bookings").select("*").eq("stripe_session_id", session.id).maybeSingle();
  if (found.error) return errorResponse(500, "Could not load the booking");
  const booking = found.data;

  if (!booking) {
    console.error(`Webhook: no booking matches session ${session.id}; acknowledged, no action`);
    return json({ received: true });
  }

  // checkout.session.completed can fire before the money settles (async
  // payment methods report payment_status "unpaid"). Nothing below this line
  // runs, and no alert is raised, until Stripe says the session is paid.
  if (session.payment_status !== "paid") {
    console.error(
      `Webhook: session ${session.id} completed but payment_status=` +
        `${session.payment_status}; booking ${booking.id} left unchanged`,
    );
    return json({ received: true });
  }

  return kind === "balance"
    ? await applyBalance(db, session, booking)
    : await applyDeposit(db, session, booking);
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
    await notifyBookingConfirmed(updated.data, balanceCentsFor(updated.data));
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
    const replay = booking.balance_session_id === session.id && booking.paid_in_full === true;
    if (!replay) {
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
  return json({ received: true });
}
