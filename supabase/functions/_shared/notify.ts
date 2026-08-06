// Notifications: render + deliver + log.
//
// COPY SYNC RULE: these templates cover the same events as the demo's
// server/templates.mjs. The two files are worded for their own contexts and
// are not word-for-word identical, but the POLICY MEANING must always agree:
// a deposit is always required (some services just do not publish the
// amount, so Ebony confirms that deposit by text), deposits are due within
// 24 hours of booking or the appointment is canceled, a paid deposit means
// the time is HELD, the rest can be brought to the appointment or paid
// online first, a price carrying a plus ("$50+") is settled in person
// because the final amount depends on the client's hair, and a paid-in-full
// service owes nothing at the appointment. If you change policy language
// here, update server/templates.mjs in the same commit. Policy lines come
// from Ke'Ebonie's own StyleSeat policies (styleseat-reference.md). Never
// invent new policy or pricing language.
//
// Delivery: email via Resend REST when RESEND_API_KEY is set, SMS via
// Twilio REST when TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
// TWILIO_FROM_NUMBER are set and the client has a phone number. When a
// provider is not configured the message is still rendered and written to
// notifications_log with status "logged" (the production stand-in for the
// demo outbox), so nothing is ever silently dropped.

import { adminDb } from "./db.ts";
import { parsePriceCents } from "./catalog.ts";
import { balanceCentsFor, paidCents } from "./money.ts";

const SITE_NAME = "Sitting Pretty";
const PHONE_LINE = "Questions? Text Ebony at (817) 704-8300.";

export interface BookingLike {
  id: string;
  client_id: string;
  client_name: string | null;
  client_email: string;
  client_phone: string | null;
  service_name: string;
  price: string;
  deposit_cents: number | null;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM 24h
  // Money model (see _shared/money.ts). Optional so callers holding an older
  // row shape still compile; missing means nothing has been paid yet.
  paid_cents?: number | null;
  paid_in_full?: boolean | null;
  status?: string | null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtDate(iso: string): string {
  // "2026-08-15" -> "Sat, Aug 15". UTC keeps the calendar date stable.
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

export function fmtMoney(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function firstName(booking: BookingLike): string {
  return booking.client_name?.trim().split(/\s+/)[0] || "there";
}

function when(booking: BookingLike): string {
  return `${fmtDate(booking.date)} at ${fmtTime(booking.time)}`;
}

// True when the up-front charge covers the whole price ("paid in full"
// services). Those must never be described as a deposit with a balance owed.
function isPaidInFull(b: BookingLike): boolean {
  const priceCents = parsePriceCents(b.price);
  return b.deposit_cents != null && priceCents != null && b.deposit_cents >= priceCents;
}

// ---------------------------------------------------------------------------
// Templates (keep policy meaning in sync with server/templates.mjs, see the
// COPY SYNC RULE at the top of this file)
// ---------------------------------------------------------------------------

interface RenderedMessage {
  subject: string;
  emailBody: string;
  // Only set when the message needs more than words (today: a broadcast
  // flyer). The plain-text emailBody is always written too, both as the
  // fallback part of the email and as what lands in notifications_log.
  emailHtml?: string;
  smsBody: string;
}

// Anything she typed goes through this before it touches an HTML email.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function tplBookingCreated(b: BookingLike, checkoutUrl: string): RenderedMessage {
  const amount = fmtMoney(b.deposit_cents ?? 0);
  if (isPaidInFull(b)) {
    return {
      subject: `Almost booked: ${b.service_name} on ${fmtDate(b.date)}`,
      emailBody: [
        `Hi ${firstName(b)},`,
        ``,
        `Your ${b.service_name} appointment is being held for ${when(b)}.`,
        ``,
        `This service is paid in full when you book. Total: ${amount}`,
        ``,
        `Pay here to lock it in: ${checkoutUrl}`,
        ``,
        `Payment is due within 24 hours of booking or the appointment is canceled. Once paid, nothing is due at your appointment.`,
        ``,
        PHONE_LINE,
        ``,
        SITE_NAME,
      ].join("\n"),
      smsBody:
        `${SITE_NAME}: your ${b.service_name} on ${when(b)} is held. ` +
        `Pay ${amount} in full within 24 hours to lock it in: ${checkoutUrl}`,
    };
  }
  return {
    subject: `Almost booked: ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `Hi ${firstName(b)},`,
      ``,
      `Your ${b.service_name} appointment is being held for ${when(b)}.`,
      ``,
      `Total: ${b.price}`,
      `Deposit to lock it in: ${amount}`,
      ``,
      `Pay your deposit here: ${checkoutUrl}`,
      ``,
      `Deposits are due within 24 hours of booking or the appointment is canceled. Your deposit comes off your balance the day of your service.`,
      ``,
      PHONE_LINE,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: your ${b.service_name} on ${when(b)} is held. ` +
      `Pay your ${amount} deposit within 24 hours to lock it in: ${checkoutUrl}`,
  };
}

function tplBookingRequest(b: BookingLike): RenderedMessage {
  return {
    subject: `Request received: ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `Hi ${firstName(b)},`,
      ``,
      `Your request for ${b.service_name} on ${when(b)} is in.`,
      ``,
      `A deposit is still required to secure your appointment. Ebony will text you to confirm your deposit and your time.`,
      ``,
      `Total: ${b.price}`,
      ``,
      PHONE_LINE,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: your request for ${b.service_name} on ${when(b)} is in. ` +
      `Ebony will text you to confirm your deposit and time.`,
  };
}

// The deposit is in, so the time is hers and nobody else can take it. Say that
// plainly, then say exactly what is still owed and that either way of paying
// it is fine. The late policy below is her own (styleseat-reference.md); never
// invent a fee, and never promise a refund.
function tplBookingConfirmed(b: BookingLike, balanceCents: number | null): RenderedMessage {
  const heldLine = paidCents(b) > 0
    ? `Your deposit is paid and this time is now held for you.`
    : `This time is now held for you.`;
  const settled = !!b.paid_in_full || isPaidInFull(b);
  const moneyLine = settled
    ? `You are paid in full. Nothing is due at your appointment.`
    : balanceCents != null
    ? `Balance still due: ${fmtMoney(balanceCents)}. Bring it to your appointment, or sign in any time and pay it online before you come.`
    : `The final amount depends on your hair, so Ebony settles the rest with you at your appointment.`;
  const smsMoney = settled
    ? ` Nothing due at your appointment.`
    : balanceCents != null
    ? ` Balance ${fmtMoney(balanceCents)} due at your appointment or online.`
    : ``;
  return {
    subject: `You are booked: ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `Hi ${firstName(b)},`,
      ``,
      `You are confirmed for ${b.service_name} on ${when(b)}.`,
      ``,
      heldLine,
      moneyLine,
      ``,
      `Please come on time. After 15 minutes the appointment is canceled and a $25 rescheduling fee applies before you can book again.`,
      ``,
      PHONE_LINE,
      ``,
      `See you soon,`,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: you are booked. ${b.service_name} on ${when(b)}. ` +
      `Your time is held.${smsMoney}`,
  };
}

// The client chose to settle the rest online instead of in the chair.
function tplBalancePaid(b: BookingLike): RenderedMessage {
  return {
    subject: `Paid in full: ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `Hi ${firstName(b)},`,
      ``,
      `Your ${b.service_name} on ${when(b)} is now paid in full. Nothing is due at your appointment.`,
      ``,
      PHONE_LINE,
      ``,
      `See you soon,`,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: ${b.service_name} on ${when(b)} is paid in full. ` +
      `Nothing due at your appointment.`,
  };
}

// Owner alert only. Money landed on an appointment that is not taking any, so
// Ebony has to decide what to do with it in Stripe. This never goes to the
// client, so nobody is promised a refund that has not happened.
function tplPaymentNeedsRefund(b: BookingLike): RenderedMessage {
  const who = b.client_name?.trim() || b.client_email;
  return {
    subject: `Payment received for an appointment that is not open: ${fmtDate(b.date)}`,
    emailBody: [
      `Heads up,`,
      ``,
      `A payment came through for an appointment that is not taking money:`,
      ``,
      b.service_name,
      when(b),
      `Client: ${who} (${b.client_email})`,
      `Status: ${b.status ?? "unknown"}`,
      ``,
      `The booking was left exactly as it was. Open this payment in your Stripe`,
      `dashboard, decide whether to refund it, and let the client know.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: a payment landed for ${who} on ${when(b)}, an appointment ` +
      `that is not taking money. Check your Stripe dashboard.`,
  };
}

function tplBookingCanceled(b: BookingLike, canceledBy: "client" | "admin"): RenderedMessage {
  const byLine = canceledBy === "admin" ? " by Ebony" : " at your request";
  return {
    subject: `Canceled: ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `Hi ${firstName(b)},`,
      ``,
      `Your ${b.service_name} appointment on ${when(b)} has been canceled${byLine}.`,
      ``,
      `Want a new time? Book again anytime, or text Ebony at (817) 704-8300.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: your ${b.service_name} on ${when(b)} has been canceled${byLine}. ` +
      `Book again anytime.`,
  };
}

// One message to everybody, with an optional flyer she attached in the
// dashboard. The flyer sits above her words and links to the full-size
// picture. SMS cannot carry an image, so the text gets the link instead of
// losing the flyer entirely.
function tplBroadcast(
  name: string | null,
  subject: string,
  message: string,
  imageUrl: string | null,
): RenderedMessage {
  const first = name?.trim().split(/\s+/)[0] || "there";

  const text = [`Hi ${first},`, ``];
  if (imageUrl) text.push(`See the flyer: ${imageUrl}`, ``);
  if (message) text.push(message, ``);
  text.push(PHONE_LINE, ``, SITE_NAME);

  let emailHtml: string | undefined;
  if (imageUrl) {
    const href = escapeHtml(imageUrl);
    const parts = [
      `<p>Hi ${escapeHtml(first)},</p>`,
      `<p><a href="${href}"><img src="${href}" alt="Flyer from ${SITE_NAME}" width="560" ` +
      `style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:12px"></a></p>`,
      `<p style="font-size:14px"><a href="${href}">Tap the picture to see it full size.</a></p>`,
    ];
    if (message) parts.push(`<p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`);
    parts.push(`<p>${PHONE_LINE}</p>`, `<p>${SITE_NAME}</p>`);
    emailHtml =
      `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;` +
      `font-size:16px;line-height:1.5;max-width:560px">${parts.join("")}</div>`;
  }

  const smsBody = imageUrl
    ? (message ? `${SITE_NAME}: ${message} ${imageUrl}` : `${SITE_NAME}: ${imageUrl}`)
    : `${SITE_NAME}: ${message}`;

  return {
    // Her subject line is optional when a flyer carries the message, but an
    // email still has to say something in the inbox list.
    subject: subject || `A note from ${SITE_NAME}`,
    emailBody: text.join("\n"),
    emailHtml,
    smsBody,
  };
}

// ---------------------------------------------------------------------------
// Delivery + logging
// ---------------------------------------------------------------------------

interface DeliveryResult {
  status: "sent" | "failed" | "logged";
  provider_id?: string;
  error?: string;
}

async function sendEmail(
  to: string | null,
  subject: string,
  body: string,
  html?: string,
): Promise<DeliveryResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key || !to) return { status: "logged" };
  const from = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "Sitting Pretty <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // text always goes along, so a mail app that refuses HTML still shows
      // the message and the flyer link.
      body: JSON.stringify({ from, to: [to], subject, text: body, ...(html ? { html } : {}) }),
    });
    if (!res.ok) return { status: "failed", error: `Resend ${res.status}: ${await res.text()}` };
    const data = await res.json();
    return { status: "sent", provider_id: data.id };
  } catch (err) {
    return { status: "failed", error: String(err) };
  }
}

async function sendSms(to: string | null, body: string): Promise<DeliveryResult> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from || !to) return { status: "logged" };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${sid}:${token}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    if (!res.ok) return { status: "failed", error: `Twilio ${res.status}: ${await res.text()}` };
    const data = await res.json();
    return { status: "sent", provider_id: data.sid };
  } catch (err) {
    return { status: "failed", error: String(err) };
  }
}

interface Recipient {
  // null only for the owner alert when no admin row exists yet. The message is
  // still rendered and written to notifications_log, never silently dropped.
  email: string | null;
  phone: string | null;
  client_id: string | null;
  booking_id: string | null;
}

async function deliver(event: string, to: Recipient, msg: RenderedMessage): Promise<void> {
  const db = adminDb();
  const emailResult = await sendEmail(to.email, msg.subject, msg.emailBody, msg.emailHtml);
  const smsResult = await sendSms(to.phone, msg.smsBody);
  const rows = [
    {
      event,
      channel: "email",
      recipient: to.email,
      subject: msg.subject,
      body: msg.emailBody,
      status: emailResult.status,
      provider_id: emailResult.provider_id ?? null,
      error: emailResult.error ?? null,
      booking_id: to.booking_id,
      client_id: to.client_id,
    },
    {
      event,
      channel: "sms",
      recipient: to.phone,
      subject: null,
      body: msg.smsBody,
      status: smsResult.status,
      provider_id: smsResult.provider_id ?? null,
      error: smsResult.error ?? null,
      booking_id: to.booking_id,
      client_id: to.client_id,
    },
  ];
  const { error } = await db.from("notifications_log").insert(rows);
  if (error) console.error("notifications_log insert failed:", error.message);
}

function bookingRecipient(b: BookingLike): Recipient {
  return {
    email: b.client_email,
    phone: b.client_phone,
    client_id: b.client_id,
    booking_id: b.id,
  };
}

// ---------------------------------------------------------------------------
// Public API, one function per event (ARCHITECTURE.md notification events)
// ---------------------------------------------------------------------------

export async function notifyBookingCreated(b: BookingLike, checkoutUrl: string): Promise<void> {
  await deliver("booking_created", bookingRecipient(b), tplBookingCreated(b, checkoutUrl));
}

export async function notifyBookingRequest(b: BookingLike): Promise<void> {
  await deliver("booking_request", bookingRecipient(b), tplBookingRequest(b));
}

// balanceCents defaults to what the booking itself says is left, so the caller
// only passes it when it already has the freshly computed number.
export async function notifyBookingConfirmed(
  b: BookingLike,
  balanceCents: number | null = balanceCentsFor(b),
): Promise<void> {
  await deliver("booking_confirmed", bookingRecipient(b), tplBookingConfirmed(b, balanceCents));
}

export async function notifyBalancePaid(b: BookingLike): Promise<void> {
  await deliver("balance_paid", bookingRecipient(b), tplBalancePaid(b));
}

// Goes to Ke'Ebonie (clients.is_admin), not to the client.
export async function notifyPaymentNeedsRefund(b: BookingLike): Promise<void> {
  const res = await adminDb()
    .from("clients")
    .select("id, email, phone")
    .eq("is_admin", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (res.error) console.error("Refund alert: could not load the owner:", res.error.message);
  const owner = res.data as { id: string; email: string; phone: string | null } | null;
  await deliver(
    "payment_needs_refund",
    {
      email: owner?.email ?? null,
      phone: owner?.phone ?? null,
      client_id: owner?.id ?? null,
      booking_id: b.id,
    },
    tplPaymentNeedsRefund(b),
  );
}

export async function notifyBookingCanceled(
  b: BookingLike,
  canceledBy: "client" | "admin",
): Promise<void> {
  await deliver("booking_canceled", bookingRecipient(b), tplBookingCanceled(b, canceledBy));
}

export async function notifyBroadcast(
  client: { id: string; email: string; name: string | null; phone: string | null },
  subject: string,
  message: string,
  imageUrl: string | null = null,
): Promise<void> {
  await deliver(
    "broadcast",
    { email: client.email, phone: client.phone, client_id: client.id, booking_id: null },
    tplBroadcast(client.name, subject, message, imageUrl),
  );
}
