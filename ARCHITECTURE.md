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

- Clients: email + 6-digit one-time code (no passwords — easy + familiar).
  Demo: the code is shown in the demo outbox. Prod: Supabase Auth email OTP.
- Ebony/admin: same flow, admin email(s) listed in server config
  (`ADMIN_EMAILS`). Her real email is still unconfirmed — demo uses
  `ebony@demo.local`; runbook swaps in her real one.

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
