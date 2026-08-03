// Notifications: render + deliver + log.
//
// COPY SYNC RULE: these templates cover the same events as the demo's
// server/templates.mjs. The two files are worded for their own contexts and
// are not word-for-word identical, but the POLICY MEANING must always agree:
// a deposit is always required (some services just do not publish the
// amount, so Ebony confirms that deposit by text), deposits are due within
// 24 hours of booking or the appointment is canceled, and a paid-in-full
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
  smsBody: string;
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

function tplBookingConfirmed(b: BookingLike): RenderedMessage {
  const balanceLine = isPaidInFull(b)
    ? `Payment received: ${fmtMoney(b.deposit_cents ?? 0)}. You are paid in full. Nothing is due at your appointment.`
    : b.deposit_cents
    ? `Deposit received: ${fmtMoney(b.deposit_cents)}. The rest of your ${b.price} balance is due the day of your service.`
    : `Total: ${b.price}. Your deposit comes off your balance the day of your service.`;
  return {
    subject: `You are booked: ${b.service_name} on ${fmtDate(b.date)}`,
    emailBody: [
      `Hi ${firstName(b)},`,
      ``,
      `You are confirmed for ${b.service_name} on ${when(b)}.`,
      ``,
      balanceLine,
      ``,
      `Please come on time. After 15 minutes the appointment is canceled and a $25 rescheduling fee applies before you can book again.`,
      ``,
      PHONE_LINE,
      ``,
      `See you soon,`,
      SITE_NAME,
    ].join("\n"),
    smsBody: `${SITE_NAME}: you are booked. ${b.service_name} on ${when(b)}. See you then!`,
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

function tplBroadcast(name: string | null, subject: string, message: string): RenderedMessage {
  const first = name?.trim().split(/\s+/)[0] || "there";
  return {
    subject,
    emailBody: [
      `Hi ${first},`,
      ``,
      message,
      ``,
      PHONE_LINE,
      ``,
      SITE_NAME,
    ].join("\n"),
    smsBody: `${SITE_NAME}: ${message}`,
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

async function sendEmail(to: string, subject: string, body: string): Promise<DeliveryResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { status: "logged" };
  const from = Deno.env.get("NOTIFY_FROM_EMAIL") ?? "Sitting Pretty <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
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
  email: string;
  phone: string | null;
  client_id: string | null;
  booking_id: string | null;
}

async function deliver(event: string, to: Recipient, msg: RenderedMessage): Promise<void> {
  const db = adminDb();
  const emailResult = await sendEmail(to.email, msg.subject, msg.emailBody);
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

export async function notifyBookingConfirmed(b: BookingLike): Promise<void> {
  await deliver("booking_confirmed", bookingRecipient(b), tplBookingConfirmed(b));
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
): Promise<void> {
  await deliver(
    "broadcast",
    { email: client.email, phone: client.phone, client_id: client.id, booking_id: null },
    tplBroadcast(client.name, subject, message),
  );
}
