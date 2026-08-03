# API Contract — Sitting Pretty booking platform

Base path `/api`. JSON in/out. Auth via `Authorization: Bearer <token>`.
Errors: `{ "error": "<human message>" }` with 4xx/5xx status.
All dates are `YYYY-MM-DD` strings, times are `HH:MM` 24h strings (America/Chicago).

Service identity: `service_id` = slugified `cat + "--" + name` lowercased,
non-alphanumerics → `-` (e.g. `sew-ins--2-part-sew-in`). Both frontend and
server derive it from services-data.js with the same `slugify` rule:
`(cat + "--" + name).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")`.

Deposit parsing from the service note (4th field):
- `/\$(\d+)\s*deposit/i` → deposit dollars
- `/paid in full|pay in full|full payment/i` → deposit = full price (numeric part of price)
- otherwise → deposit null (booking is request-only, no payment step)

## Auth
- `POST /api/auth/request-code` `{email}` → `{ok:true}` — creates 6-digit code,
  10-min expiry, delivers via email (demo: visible in outbox).
- `POST /api/auth/verify` `{email, code}` → `{token, client:{id,email,name,phone,is_admin}}`
  — creates the client record on first login. Token is opaque, server-side session.
- `GET /api/me` (auth) → `{client, bookings:[Booking]}` (their bookings, newest first)
- `POST /api/me` (auth) `{name?, phone?}` → `{client}` — update profile.

## Booking (client)
- `GET /api/services` → `{categories:[{cat, items:[{service_id,name,price,duration_min,deposit_cents|null,note}]}]}`
  (server-derived from services-data.js so client and server always agree)
- `GET /api/availability?service_id=X&date=YYYY-MM-DD` →
  `{date, closed:bool, blocked:bool, slots:["09:00","09:30",...]}`
- `POST /api/bookings` (auth) `{service_id, date, time, notes?}` →
  `{booking, checkout_url}` — `checkout_url` null when deposit is null
  (status `confirmed`-pending-Ebony, labeled `request`) else status
  `awaiting_deposit` and checkout_url points to Stripe Checkout (demo:
  `/demo-checkout?session=<id>`).
- `POST /api/bookings/:id/cancel` (auth; owner or admin) → `{booking}` —
  sets `canceled`, records who, sends cancellation notification.

Booking object:
`{id, client_id, client_name, client_email, client_phone, service_id, service_name,
  price, deposit_cents, date, time, duration_min, status, notes, created_at,
  canceled_by?}`
status ∈ `awaiting_deposit | request | confirmed | completed | canceled`.

## Payments
- `GET /api/checkout/:session_id` → `{booking, amount_cents, service_name}` (demo checkout page data)
- `POST /api/checkout/:session_id/pay` → `{ok, booking}` — DEMO ONLY simulated
  payment success; marks deposit paid → `confirmed`, sends confirmation.
- `POST /api/stripe/webhook` — production path (checkout.session.completed →
  same transition). Mock accepts it too for parity testing.

## Admin (auth + is_admin, else 403)
- `GET /api/admin/bookings?from=&to=&status=` → `{bookings:[Booking]}` (all, filterable)
- `POST /api/admin/bookings/:id/status` `{status}` → `{booking}` — allowed:
  confirmed, completed, canceled (canceled sends notification to client).
- `GET /api/admin/blocked-days` → `{days:[{date,reason}]}`
- `POST /api/admin/blocked-days` `{date, reason?}` → `{days}` (idempotent)
- `DELETE /api/admin/blocked-days/:date` → `{days}`
- `GET /api/admin/clients` → `{clients:[{id,email,name,phone,bookings_count,last_booking}]}`
- `POST /api/admin/broadcast` `{subject, message}` → `{sent:int}` — one message
  to every client (email + sms template), logged in broadcasts.

## Demo helpers (mock server only — NOT in production)
- `GET /api/_outbox` → `{messages:[{ts,channel:"email"|"sms",to,subject,body}]}` newest first
- `POST /api/_reset` → reseed demo data (a few sample bookings/clients)

Mock server env: `PORT` (default 4870), `ADMIN_EMAILS` (default `ebony@demo.local`),
`STRIPE_SECRET_KEY` optional (if set, real Stripe test-mode Checkout via REST).
