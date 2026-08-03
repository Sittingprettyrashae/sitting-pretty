# Sitting Pretty — Booking Platform Architecture

Client-requested v2 (2026-08-02): feminine light design, StyleSeat-familiar UX,
Stripe deposits/payments, client accounts with repeat booking, date+time booking,
email/SMS confirmations and cancellations, Ebony dashboard with master broadcast.

## Stack

- **Frontend**: static HTML/CSS/JS, deployable to GitHub Pages.
  - `index.html` — public site + booking flow (client-facing)
  - `dashboard.html` — Ebony's admin dashboard
  - `css/tokens.css` — shared design tokens (single source of truth for both pages)
  - `js/api.js` — shared API client (auth token in localStorage `sp_token`)
  - `services-data.js` — service catalog (verbatim StyleSeat pricing)
- **Backend, local demo**: `server/server.mjs` — zero-dependency Node http server.
  Serves the static files AND the `/api/*` contract. JSON-file persistence
  (`server/db.json`). Simulated Stripe Checkout at `/demo-checkout` and a demo
  message outbox (emails/SMS the system "sent") at `/api/_outbox`.
- **Backend, production**: Supabase (Postgres + Auth + Edge Functions) + Stripe
  Checkout + Resend email (+ Twilio SMS optional). Code in `supabase/`,
  wiring steps in `RUNBOOK.md`. Same API contract as the mock.

## Money flow

Stripe Checkout session per booking for the DEPOSIT amount (parsed from the
service's note: "$25 deposit" etc.). "Paid in full" services charge full price.
Services with no parsable deposit create a booking request with no payment
(Ebony confirms by text). Deposits are due within 24h of booking (her policy);
unpaid bookings show as `awaiting_deposit` and Ebony can cancel from dashboard.
Payments land in HER Stripe account (runbook: she creates it; never Nelson's).

## Booking rules

- Hours: Sun closed · Mon–Fri 9:00–20:00 · Sat 9:00–18:00 (from her StyleSeat).
- Slot step 30 min. A service blocks its full duration; last start = close − duration.
- One client at a time: any overlap with a non-canceled booking removes the slot.
- Blocked days (set from dashboard) remove the whole day.
- Booking statuses: `awaiting_deposit` → `confirmed` (deposit paid or admin
  confirm) → `completed`; `canceled` (by client or admin, with notification).

## Auth

Three ways in, all ending at the same `{token, client}`. Full contract in API.md.

- **Google** (primary): one tap, no password to remember. Demo has a clearly
  labeled stand-in chooser; production uses Supabase Auth's Google provider.
  A Google sign-in whose verified email matches an existing account signs into
  that account instead of creating a second one.
- **Email + password**: scrypt hashes with a per-user salt. Wrong password and
  unknown email return identical text so nobody can probe who has an account.
- **Emailed 6-digit code**: the fallback, and how a password gets reset. Demo
  shows the code in the outbox; production sends it through Supabase.

Sessions last 90 days and slide on use, so repeat clients book without signing
in again. Changing a password drops every existing session for that account.

The owner account is not claimable by whoever signs up first with her address:
she signs in with an email code (proving she owns the inbox) and sets a
password from there. Admin email(s) come from `ADMIN_EMAILS`; her real address
is still unconfirmed, so the demo uses `ebony@demo.local` and the runbook
swaps in the real one.

## Notifications (email now; SMS-ready)

Events: booking created (with deposit link), deposit paid/confirmed, canceled
(either side), broadcast. Each renders to email AND sms text templates
(`server/templates.mjs` locally, mirrored in the edge functions). Local demo
logs them to the outbox; production sends via Resend, and via Twilio when
Nelson/Ke'Ebonie decide to fund an SMS number.

## Broadcast

Dashboard composer → POST /api/admin/broadcast → one message to every client
account (email + SMS when available). For "I'm sick" / holiday closures she can
also block the affected days so no one can book them.
