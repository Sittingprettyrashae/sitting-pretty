// Notifications: render + deliver + log.
//
// COPY SYNC RULE: these templates cover the same events as the demo's
// server/templates.mjs. The two files are worded for their own contexts and
// are not word-for-word identical, but the POLICY MEANING must always agree:
// a deposit is always required (some services just do not publish the
// amount, so Ebony confirms that deposit by text), THE DEPOSIT IS WHAT BOOKS
// THE SPOT so an appointment only exists once it is paid, a paid deposit
// means the time is HELD, the rest can be brought to the appointment or paid
// online first, a price carrying a plus ("$50+") is settled in person
// because the final amount depends on the client's hair, and a paid-in-full
// service owes nothing at the appointment. The 24-hour deposit deadline still
// appears in one place, the cancellation notice for appointments booked
// before the hold model existed (_shared/deposits.ts). If you change policy
// language here, update server/templates.mjs in the same commit. Policy lines
// come from Ke'Ebonie's own StyleSeat policies (styleseat-reference.md).
// Never invent new policy or pricing language.
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
  // What the client typed in the booking sheet. Only the owner messages show
  // it, so she knows what to expect before the client sits down.
  notes?: string | null;
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
  const name = who(b);
  return {
    subject: `Payment received for an appointment that is not open: ${fmtDate(b.date)}`,
    emailBody: [
      `Heads up,`,
      ``,
      `A payment came through for an appointment that is not taking money:`,
      ``,
      b.service_name,
      when(b),
      `Client: ${name} (${b.client_email})`,
      `Status: ${b.status ?? "unknown"}`,
      `Reach her at ${reachAt(b)}`,
      ``,
      `The booking was left exactly as it was. Open this payment in your Stripe`,
      `dashboard, decide whether to refund it, and let the client know.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: a payment landed for ${name} on ${when(b)}, an appointment ` +
      `that is not taking money. Check your Stripe dashboard.`,
  };
}

// Her deposit rule, actually enforced: a deposit that never arrived within 24
// hours of booking cancels the appointment. Wording is her own policy from
// styleseat-reference.md, nothing new invented.
function tplBookingCanceledDepositUnpaid(b: BookingLike): RenderedMessage {
  return {
    subject: `Canceled: ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `Hi ${firstName(b)},`,
      ``,
      `Your ${b.service_name} appointment on ${when(b)} has been canceled because the deposit was not paid within 24 hours of booking.`,
      ``,
      `A deposit is what secures every appointment. You are welcome to book again anytime.`,
      ``,
      PHONE_LINE,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: your ${b.service_name} on ${when(b)} was canceled because the ` +
      `deposit was not paid within 24 hours. Book again anytime.`,
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

// ---------------------------------------------------------------------------
// What Ebony is told (API.md "What Ebony is told"). She should never have to
// open the dashboard to find out something happened to her day.
//
// These are OWNER messages. They are never sent to a client, which is why the
// only way to send one is deliverToOwner() below: it resolves her address
// itself and takes no recipient argument. Every one of them names the client
// and her number, so Ebony can act straight from the message.
// ---------------------------------------------------------------------------

function who(b: BookingLike): string {
  return b.client_name?.trim() || b.client_email || "A client";
}

// How to reach the client, best contact first. Never invent one: say plainly
// when there is nothing on file.
function reachAt(b: BookingLike): string {
  return b.client_phone?.trim() || b.client_email || "no contact on file";
}

function summaryLines(b: BookingLike): string[] {
  const lines = [b.service_name, when(b), `Price: ${b.price}`];
  if (b.deposit_cents != null) lines.push(`Deposit: ${fmtMoney(b.deposit_cents)}`);
  return lines;
}

// What is still owed, in her words, for a booking whose deposit just landed.
function stillOwed(b: BookingLike, balanceCents: number | null): string {
  if (b.paid_in_full || isPaidInFull(b)) return "nothing left to collect";
  if (balanceCents != null) return `${fmtMoney(balanceCents)} due at the appointment`;
  return "the rest settled with her in person";
}

function tplOwnerNewBooking(b: BookingLike, balanceCents: number | null): RenderedMessage {
  const name = who(b);
  const deposit = fmtMoney(b.deposit_cents ?? 0);
  return {
    subject: `New booking: ${name}, ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `${name} just booked and paid the deposit.`,
      ``,
      ...summaryLines(b),
      `Deposit received: ${deposit}`,
      `Still owed: ${stillOwed(b, balanceCents)}`,
      ``,
      `Reach her at ${reachAt(b)}`,
      ...(b.notes?.trim() ? [``, `What she said: ${b.notes.trim()}`] : []),
      ``,
      `This time is now blocked off for you.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `New booking: ${name}, ${b.service_name} ${when(b)}. Deposit ${deposit} paid.` +
      (b.client_phone ? ` Her number: ${b.client_phone}` : ``),
  };
}

function tplOwnerBookingRequest(b: BookingLike): RenderedMessage {
  const name = who(b);
  return {
    subject: `Needs your yes: ${name}, ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `${name} asked for a time. This service has no published deposit, so it is waiting on you.`,
      ``,
      ...summaryLines(b),
      ``,
      `Reach her at ${reachAt(b)}`,
      ...(b.notes?.trim() ? [``, `What she said: ${b.notes.trim()}`] : []),
      ``,
      `Confirm it or cancel it in your dashboard.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `Booking request: ${name}, ${b.service_name} ${when(b)}. Needs your yes.` +
      (b.client_phone ? ` Her number: ${b.client_phone}` : ``),
  };
}

function tplOwnerClientCanceled(b: BookingLike): RenderedMessage {
  const name = who(b);
  return {
    subject: `Client cancellation: ${name} on ${fmtDate(b.date)}`,
    emailBody: [
      `${name} canceled her appointment.`,
      ``,
      ...summaryLines(b),
      ``,
      `Reach her at ${reachAt(b)}`,
      ``,
      `That slot is open again.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${name} canceled ${b.service_name} on ${when(b)}. That slot is open again.` +
      (b.client_phone ? ` Her number: ${b.client_phone}` : ``),
  };
}

function tplOwnerBalancePaid(b: BookingLike, amountCents: number): RenderedMessage {
  const name = who(b);
  return {
    subject: `Paid in full: ${name} on ${fmtDate(b.date)}`,
    emailBody: [
      `${name} just paid the rest online.`,
      ``,
      ...summaryLines(b),
      `Paid online: ${fmtMoney(amountCents)}`,
      ``,
      `Reach her at ${reachAt(b)}`,
      ``,
      `Nothing to collect at this appointment.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${name} paid the rest of ${b.service_name} (${when(b)}) online. ` +
      `Nothing to collect.`,
  };
}

function tplOwnerDepositExpired(b: BookingLike): RenderedMessage {
  const name = who(b);
  return {
    subject: `Slot reopened: ${name} never paid the deposit`,
    emailBody: [
      `${name} did not pay the deposit within 24 hours, so this appointment was canceled and the time is open again.`,
      ``,
      ...summaryLines(b),
      ``,
      `Reach her at ${reachAt(b)} if you want to give her another shot.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${name} never paid the deposit for ${b.service_name} on ${when(b)}. ` +
      `That time is open again.`,
  };
}

// Money landed on a hold that had already run out, so nothing went on her
// calendar. Owner alert only: the client is never promised a refund that has
// not happened.
export interface ExpiredHoldPayment {
  service_name: string | null;
  date: string | null;
  time: string | null;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  amount_cents: number | null;
}

function tplOwnerHoldExpiredRefund(h: ExpiredHoldPayment): RenderedMessage {
  const name = h.client_name?.trim() || h.client_email || "A client";
  const slot = h.date && h.time ? `${fmtDate(h.date)} at ${fmtTime(h.time)}` : "an unknown time";
  return {
    subject: `Refund needed: a deposit landed after the hold ran out`,
    emailBody: [
      `Heads up,`,
      ``,
      `A deposit came through after the hold on that time had already run out, so nothing was put on your calendar and the slot is still open.`,
      ``,
      h.service_name ?? "Service not recorded",
      slot,
      `Client: ${name}${h.client_email ? ` (${h.client_email})` : ""}`,
      `Reach her at ${h.client_phone?.trim() || h.client_email || "no contact on file"}`,
      ...(h.amount_cents != null ? [`Paid: ${fmtMoney(h.amount_cents)}`] : []),
      ``,
      `Refund this one in your Stripe dashboard and let her know she can pick a new time.`,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody:
      `${SITE_NAME}: a deposit landed for ${name} after the hold on ${slot} ran out. ` +
      `Nothing was booked. Refund it in Stripe.`,
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

// Where owner alerts go: her admin account (RUNBOOK step 2 grants is_admin by
// email), with OWNER_EMAIL / OWNER_PHONE as overrides for a project where the
// admin row does not exist yet or where she wants alerts somewhere else.
// SMS only happens once a number is on file and Twilio is configured; email
// always works.
async function ownerContact(): Promise<Recipient> {
  const envEmail = (Deno.env.get("OWNER_EMAIL") ?? "").trim();
  const envPhone = (Deno.env.get("OWNER_PHONE") ?? "").trim();
  const res = await adminDb()
    .from("clients")
    .select("id, email, phone")
    .eq("is_admin", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (res.error) console.error("Owner alert: could not load the owner:", res.error.message);
  const owner = res.data as { id: string; email: string; phone: string | null } | null;
  return {
    email: envEmail || owner?.email || null,
    phone: envPhone || owner?.phone || null,
    client_id: owner?.id ?? null,
    booking_id: null,
  };
}

// THE ONLY WAY TO SEND AN OWNER MESSAGE.
//
// Owner alerts name the client and her phone number, so one addressed to the
// wrong person would hand a stranger someone else's contact details. This
// function resolves Ebony's address itself and takes no recipient argument, so
// there is no call site where the wrong address can be passed in. Nothing else
// in this file sends an owner template.
async function deliverToOwner(
  event: string,
  msg: RenderedMessage,
  bookingId: string | null,
): Promise<void> {
  const owner = await ownerContact();
  await deliver(event, { ...owner, booking_id: bookingId }, msg);
}

// ---------------------------------------------------------------------------
// Public API, one function per event (ARCHITECTURE.md notification events)
// ---------------------------------------------------------------------------

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

export async function notifyBookingCanceled(
  b: BookingLike,
  canceledBy: "client" | "admin",
): Promise<void> {
  await deliver("booking_canceled", bookingRecipient(b), tplBookingCanceled(b, canceledBy));
}

// The 24-hour deposit deadline ran out (see _shared/deposits.ts).
export async function notifyDepositExpired(b: BookingLike): Promise<void> {
  await deliver(
    "booking_canceled_deposit_unpaid",
    bookingRecipient(b),
    tplBookingCanceledDepositUnpaid(b),
  );
}

// ---------------------------------------------------------------------------
// Owner alerts. All six events in API.md "What Ebony is told". Every one of
// these goes to HER and only her, through deliverToOwner.
// ---------------------------------------------------------------------------

/** A deposit landed and a new appointment is on the books. */
export async function notifyOwnerNewBooking(
  b: BookingLike,
  balanceCents: number | null = balanceCentsFor(b),
): Promise<void> {
  await deliverToOwner("owner_new_booking", tplOwnerNewBooking(b, balanceCents), b.id);
}

/** A service with no published deposit: it is waiting on her yes. */
export async function notifyOwnerBookingRequest(b: BookingLike): Promise<void> {
  await deliverToOwner("owner_booking_request", tplOwnerBookingRequest(b), b.id);
}

/** The client canceled. She did not, so she needs telling. */
export async function notifyOwnerClientCanceled(b: BookingLike): Promise<void> {
  await deliverToOwner("owner_client_canceled", tplOwnerClientCanceled(b), b.id);
}

/** The rest of the price came in online, so there is nothing to collect. */
export async function notifyOwnerBalancePaid(
  b: BookingLike,
  amountCents: number,
): Promise<void> {
  await deliverToOwner("owner_balance_paid", tplOwnerBalancePaid(b, amountCents), b.id);
}

/** A deposit never arrived, the appointment came off, the slot reopened. */
export async function notifyOwnerDepositExpired(b: BookingLike): Promise<void> {
  await deliverToOwner("owner_deposit_expired", tplOwnerDepositExpired(b), b.id);
}

/** Money landed on a booking that is not taking any. Goes to her, not the client. */
export async function notifyPaymentNeedsRefund(b: BookingLike): Promise<void> {
  await deliverToOwner("payment_needs_refund", tplPaymentNeedsRefund(b), b.id);
}

/**
 * A deposit landed after the hold had already run out, so no appointment was
 * created. There is no booking row to point at, which is why this takes the
 * hold (or what the Stripe session knew) instead.
 */
export async function notifyHoldExpiredRefund(h: ExpiredHoldPayment): Promise<void> {
  await deliverToOwner("hold_expired_refund", tplOwnerHoldExpiredRefund(h), null);
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
