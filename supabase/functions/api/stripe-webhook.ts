// POST /api/stripe/webhook
// Signature-verified Stripe webhook. checkout.session.completed marks the
// booking's deposit paid: awaiting_deposit -> confirmed, then the client
// gets the confirmation email/SMS. A booking is only confirmed when the
// session's payment_status is "paid" AND amount_total equals the booking's
// deposit_cents; anything else is logged and acknowledged without changes.
// Replays are idempotent. Endpoint setup: RUNBOOK step 4.

import type Stripe from "npm:stripe@17";

import { adminDb } from "../_shared/db.ts";
import { errorResponse, json } from "../_shared/http.ts";
import { notifyBookingConfirmed } from "../_shared/notify.ts";
import { getStripe, stripeCryptoProvider } from "../_shared/stripe.ts";

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

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const db = adminDb();

    const bookingId = session.metadata?.booking_id;
    const found = bookingId
      ? await db.from("bookings").select("*").eq("id", bookingId).maybeSingle()
      : await db.from("bookings").select("*").eq("stripe_session_id", session.id).maybeSingle();
    if (found.error) return errorResponse(500, "Could not load the booking");
    const booking = found.data;

    if (!booking) {
      console.error(`Webhook: no booking matches session ${session.id}; acknowledged, no action`);
      return json({ received: true });
    }

    // Idempotency: only awaiting_deposit can transition. Replayed events and
    // already-confirmed/canceled bookings are acknowledged with no side
    // effects.
    if (booking.status !== "awaiting_deposit") return json({ received: true });

    // checkout.session.completed can fire before the money settles (async
    // payment methods report payment_status "unpaid"). Never confirm until
    // Stripe says the session is actually paid.
    if (session.payment_status !== "paid") {
      console.error(
        `Webhook: session ${session.id} completed but payment_status=` +
          `${session.payment_status}; booking ${booking.id} stays awaiting_deposit`,
      );
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

    // Atomic transition: the status filter makes concurrent replays race
    // safely; only the delivery that actually flips the row sends the email.
    const updated = await db
      .from("bookings")
      .update({ status: "confirmed", deposit_paid_at: new Date().toISOString() })
      .eq("id", booking.id)
      .eq("status", "awaiting_deposit")
      .select("*")
      .maybeSingle();
    if (updated.error) return errorResponse(500, "Could not confirm the booking");
    if (updated.data) await notifyBookingConfirmed(updated.data);
  }

  return json({ received: true });
}
