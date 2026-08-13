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

Three ways in, all landing on the same `{token, client}` shape. Sessions are
long-lived (90 days, sliding: touched on each authenticated request) so repeat
clients stay signed in and never need a code for routine booking.

`client` object: `{id, email, name, phone, is_admin, has_password, auth_provider}`
where `auth_provider` ∈ `password | google | code`.

**Password (primary)**
- `POST /api/auth/signup` `{email, password, name?, phone?}` → `{token, client}`
  - password rules: min 8 chars, not a known-trivial value; server stores
    scrypt hash + per-user salt, never the password.
  - if the email already has an account: 409 `{error}` with a message pointing
    at log-in or password reset. Never reveal more than that.
- `POST /api/auth/login` `{email, password}` → `{token, client}`
  - wrong password OR unknown email both return the same 401 message.
  - if the account exists but has no password yet (created by an older code
    login), respond 409 `{error, needs_password_setup:true}` so the UI can
    route them through the code flow once and set a password. This response
    does reveal that the address has an account, which is why it counts
    against the rate limit exactly like a failed guess: the disclosure is
    bounded rather than an unlimited oracle.
  - Rate limited: 8 attempts / 15 min, tracked per email and per IP. The
    attempt is recorded BEFORE the password is checked (verifying a hash
    yields the event loop, so counting afterwards let concurrent guesses all
    slip past the gate) and forgiven on success, so a client who knows her
    password is not locked out by someone else guessing from the same network.
    Over the limit returns 429 with a wait message.

**Google**
- `GET /api/auth/google/start?redirect=<path>` → 302 to Google's consent screen
  (production). Demo mock: 302 to `/demo-google?redirect=…`, a clearly-labeled
  fake account chooser so the flow is clickable without Google credentials.
- `GET /api/auth/google/callback?code=…&state=…` → validates state, exchanges the
  code, upserts the client by verified email, then 302s back to
  `<redirect>#sp_token=<token>` for the frontend to store.
  - State validation is two-part: the stored state AND a nonce cookie
    (`sp_oauth`, HttpOnly, SameSite=Lax) set when the sign-in started. Checking
    only that the state exists is not enough, since anyone can mint one; a
    crafted callback link would otherwise sign a victim into someone else's
    account. The cookie is cleared once the sign-in completes.
  - The demo chooser refuses to issue a session for an admin address, because
    nothing in it verifies the email the way Google does.
- Account linking: a Google sign-in whose email matches an existing account
  signs into THAT account (email is verified by Google, so this is safe) and
  leaves any existing password intact.

**Email code (fallback + password reset)**
- `POST /api/auth/request-code` `{email, purpose?}` → `{ok:true}` — 6-digit code,
  10-min expiry, 5 attempts, rate limited. `purpose` ∈ `login | reset`.
- `POST /api/auth/verify` `{email, code}` → `{token, client}` — creates the
  client on first login.
- `POST /api/auth/set-password` (auth) `{password}` → `{client}` — sets or
  replaces the password for the signed-in client. This is the last step of a
  reset and the "add a password" path for code-only accounts.

**Session**
- `POST /api/auth/logout` (auth) → `{ok:true}` — invalidates the current token.
- `GET /api/me` (auth) → `{client, bookings:[Booking]}` (their bookings, newest first)
- `POST /api/me` (auth) `{name?, phone?}` → `{client}` — update profile.

## Hours (she owns her own schedule)

Hours are DATA, not code. One source of truth: the availability engine, the
dashboard, and the hours table on the public site all read the same record, so
her site can never advertise hours she does not actually work.

- `GET /api/hours` (public) → `{days:[{weekday, closed, open, close}]}`
  `weekday` 0=Sunday..6=Saturday, `open`/`close` are `"HH:MM"` 24h, and are
  null when `closed` is true. Always returns all 7 days in weekday order.
- `GET /api/admin/hours` (admin) → same shape.
- `PUT /api/admin/hours` (admin) `{days:[{weekday, closed, open?, close?}]}` →
  `{days}`. Validation: every weekday 0..6 present exactly once, `open` before
  `close`, times on the half hour. Rejects with 400 and a plain message.

**Changing hours never touches existing bookings.** If she narrows a day,
appointments already on the books stay exactly where they are: they were
promised to a client. New bookings simply cannot be made outside the new hours.
The response includes `affected:[Booking]` listing any non-canceled future
bookings that now fall outside her hours, so the dashboard can show her which
ones to move or keep. Defaults if she never touches it: Sunday closed,
Monday to Friday 09:00-20:00, Saturday 09:00-18:00 (her StyleSeat hours).

## Booking (client)
- `GET /api/services` → `{categories:[{cat, items:[{service_id,name,price,duration_min,deposit_cents|null,note}]}]}`
  THE MENU LIVES IN THE DATABASE (public.services), edited from the
  dashboard's Menu tab; services-data.js is only the seed and the fallback
  for an unseeded or unreachable table. Existing bookings are never affected
  by menu edits: they snapshot name/price/deposit at booking time.
- `GET /api/availability?service_id=X&date=YYYY-MM-DD` →
  `{date, closed:bool, blocked:bool, slots:["09:00","09:30",...]}`
- `POST /api/bookings` (auth) `{service_id, date, time, notes?}` →
  `{hold, checkout_url}` for a service with a deposit, or `{booking}` for a
  request-only service.

  **Deposit first: no money, no appointment.** A service with a published
  deposit does NOT create a booking here. It creates a **hold**: the slot is
  reserved for `HOLD_MINUTES` (15) while she completes checkout, and only
  becomes a real booking when the deposit is paid. Nobody else can take the
  slot during the hold. If she abandons checkout, the hold expires and the time
  is immediately free again.

  This replaces the old behaviour, where an unpaid booking sat on the calendar
  for 24 hours. That let someone who never paid tie up a Saturday.

  `hold` = `{id, expires_at, service_id, service_name, price, deposit_cents,
  date, time, duration_min}`. Availability excludes both bookings and unexpired
  holds. Expired holds are swept on every availability and booking read, so a
  slot never stays locked by an abandoned checkout.

  Request-only services (no published deposit) are unchanged: they create a
  booking with status `request` for Ebony to confirm, because there is no
  amount to charge up front.
- `POST /api/holds/:id/refresh` (auth, owner) → `{hold}` — extends an unexpired
  hold once while she is still on the checkout page. Refuses an expired hold
  with 410 so the UI can send her back to pick a new time.
- `POST /api/bookings/:id/cancel` (auth; owner or admin) → `{booking}` —
  sets `canceled`, records who, sends cancellation notification.
- `POST /api/bookings/:id/pay-balance` (auth; owner or admin) →
  `{checkout_url, amount_cents}` — Stripe Checkout for the rest of the price,
  for a client who would rather not settle up in the chair. `amount_cents` is
  the booking's `balance_cents`; the session carries `metadata.kind=balance`
  and `metadata.booking_id`. Refusals, all 409:
  - cancelled appointment → "That appointment was cancelled."
  - still `awaiting_deposit` → "Pay the deposit first, then the rest can be
    paid any time." (the deposit is what holds the time)
  - already settled → "This one is already paid in full."
  - variable price → "The final amount for this service depends on your hair,
    so Ebony settles it with you in person."

Booking object:
`{id, client_id, client_name, client_email, client_phone, service_id, service_name,
  price, deposit_cents, date, time, duration_min, status, notes, created_at,
  canceled_by?, deposit_paid_at?}`
status ∈ `awaiting_deposit | request | confirmed | completed | canceled`.

Money fields, on every Booking the API returns:
- `paid_cents` int — everything that has landed: deposit, online balance, and
  anything collected in person. Stored, only ever added to.
- `total_cents` int|null — the full price in cents, DERIVED from the price
  string. `null` when the price is variable (see below).
- `balance_cents` int|null — `total_cents - paid_cents` when that is positive,
  the price is fixed, and the booking is not already paid in full. Otherwise
  `null`, which means there is nothing to offer online. DERIVED.
- `paid_in_full` bool — true once `paid_cents >= total_cents`, or the moment
  the owner records an in-person payment.
- `paid_in_person` bool — the owner took the rest herself (cash, Zelle, card
  reader), recorded via `mark-paid`.

**Variable-price rule.** A price carrying a plus (`"$50+"`) means the final
amount depends on the client's hair, length, or add-ons. Those bookings have
`total_cents: null` and `balance_cents: null`, are NEVER offered a fixed online
balance, and are settled with Ebony in person. Only `mark-paid` with an explicit
`amount_cents` can record what one of them actually cost.

Payment effects:
- deposit paid → the hold becomes a booking with status `confirmed`,
  `deposit_paid_at` set, deposit added to `paid_cents`, confirmation
  notification to the client (states the time is held and what is still owed)
  AND a new-booking notification to Ebony.
- balance paid → added to `paid_cents`, `paid_in_full` true, paid-in-full
  notification to the client and a payment notification to Ebony.

## Leads & Reviews
- `POST /api/leads` `{name, email, phone?, source?}` → `{ok:true}` — the site
  popup's waitlist signup. The one public write in the API: strict validation
  (phone, when given, must carry 10–15 digits), a per-IP throttle (6/min →
  429), a honeypot field (`company` — any non-empty value gets `{ok:true}`
  and no row), and a duplicate email answers exactly like a fresh one so the
  list can't be probed.
- `GET /api/reviews` → `{reviews:[{name,service,rating,body,source,ts}], count}`
  — APPROVED reviews only, newest first, max 60. `name` is shortened to first
  name + last initial ("Tasha R."); the full name stays admin-only. `source`
  is `site` (written here) or `styleseat` (imported verbatim from her
  StyleSeat profile), and the wall labels the imported ones "via StyleSeat".
- `POST /api/reviews` `{rating:1-5, body, service?}` (auth) → `{ok:true}` —
  signed-in clients only. The display name is snapshotted from the profile
  server-side. ONE review per client, the latest wins, and every save (new or
  edited) goes back to `pending` until Ebony approves it in her dashboard.
  Nothing shows publicly before that.

## What Ebony is told (owner notifications)

She should never have to open the dashboard to find out something happened.
Every event that changes her day reaches her by email, and by SMS once a number
is configured. Owner notifications go to the configured owner address and her
phone: `ADMIN_EMAILS[0]` + `OWNER_PHONE` on the mock server, and on production
her admin account (the `clients` row with `is_admin`), which `OWNER_EMAIL` and
`OWNER_PHONE` override when set.

| Event | She is told |
|---|---|
| Deposit paid, new booking on the books | who, what, when, how much landed, what is still owed |
| Booking request received (no published deposit) | who, what, when, and that it needs her yes |
| Client cancels | who, what, when, and that the slot reopened |
| Balance paid online | who, what, and that nothing is due in the chair |
| Deposit never paid, appointment auto-cancelled | who, what, when, and that the slot reopened |
| Payment landed on a dead booking | refund this one in Stripe |

Owner messages name the client and their phone number so she can act straight
from the notification. They are never sent to the client.

## Payments
- `GET /api/checkout/:session_id` → `{booking, amount_cents, service_name}` (demo checkout page data)
- `POST /api/checkout/:session_id/pay` → `{ok, booking}` — DEMO ONLY simulated
  payment success; marks deposit paid → `confirmed`, sends confirmation.
- `POST /api/stripe/webhook` — production path (checkout.session.completed →
  same transition). Mock accepts it too for parity testing. The session's
  `metadata.kind` selects the path: `balance` applies a balance payment,
  anything else (including sessions predating the field) is the deposit. A
  deposit session carries `metadata.hold_id`, the slot it is paying for, and
  that is what becomes the booking. A deposit session carrying `booking_id`
  instead is one created before the hold model and still confirms its
  `awaiting_deposit` booking. Paying for a hold that has already expired
  creates nothing and raises the refund alert.
  Production verifies the Stripe signature, requires `payment_status: "paid"`,
  requires `amount_total` to equal what was expected for that kind (the
  `deposit_cents`, or the computed `balance_cents`), is idempotent on replay,
  and alerts the owner to refund in Stripe when money lands on a booking that
  is not taking any. A mismatch changes nothing.

## Admin (auth + is_admin, else 403)
- `GET /api/admin/bookings?from=&to=&status=` → `{bookings:[Booking]}` (all, filterable)
- `POST /api/admin/bookings/:id/status` `{status}` → `{booking}` — allowed:
  confirmed, completed, canceled (canceled sends notification to client).
- `POST /api/admin/bookings/:id/mark-paid` `{amount_cents?}` → `{booking}` —
  she settled up with the client in person. Records `amount_cents` when given
  (required in practice for variable prices, which have no computed balance),
  otherwise the booking's `balance_cents`. Adds it to `paid_cents`, sets
  `paid_in_full` and `paid_in_person`, and promotes `awaiting_deposit` or
  `request` to `confirmed`. 409 on a cancelled appointment. No client
  notification: she is standing right there.
- `GET /api/admin/blocked-days` → `{days:[{date,reason}]}`
- `POST /api/admin/blocked-days` `{date, reason?}` → `{days}` (idempotent)
- `DELETE /api/admin/blocked-days/:date` → `{days}`
- `GET /api/admin/clients` → `{clients:[{id,email,name,phone,bookings_count,last_booking}]}`
- `GET /api/admin/services` → `{services:[{service_id,cat,name,price,duration_min,deposit_cents,note,active,cat_order,sort_order}]}` — her whole menu including hidden styles.
- `POST /api/admin/services` `{cat, name, price, duration_min, deposit_cents?, note?}`
  → `{service}` — add a style (409 if the slug already exists and is active;
  re-adding a removed style revives it with the new details). Price must look
  like `$75` or `$50+`; duration 15–720 min; deposit in cents or null
  (null = request-only, she confirms by text).
- `PUT /api/admin/services/:service_id` `{price?, duration_min?, deposit_cents?, note?, name?}`
  → `{service}` — edit; the slug never changes, even on rename, so existing
  bookings keep resolving.
- `POST /api/admin/services/:service_id/active` `{active}` → `{service}` —
  remove (hide) or restore a style. Hidden styles cannot be booked and do not
  appear on the site.
- `GET /api/admin/leads` → `{leads:[{id,name,email,phone,source,ts}]}` — her
  waitlist from the site popup, newest first.
- `DELETE /api/admin/leads/:id` → `{leads}` — take someone off the waitlist
  (the broadcast footer invites "just reply" opt-outs; this honors them).
- `GET /api/admin/reviews` → `{reviews:[{id,name,service,rating,body,status,ts}]}`
  — every review, pending first (ordered before the limit, so pending rows
  can never be crowded out).
- `POST /api/admin/reviews/:id/status` `{status}` → `{review}` — allowed:
  approved (shows on the site), hidden, pending.
- `POST /api/admin/broadcast` `{subject, message, image?, include_leads?}` → `{sent:int, image_url?}`
  — one message to every client (email + sms), logged in broadcasts. With
  `include_leads: true` the waitlist gets it too, minus anyone whose email is
  already a client, so nobody hears it twice. Both audiences (and the flyer)
  are loaded BEFORE anything sends, so any failure means nobody was messaged
  and pressing send again is safe.
  - `image` is an optional flyer as a data URL (`data:image/jpeg;base64,...`).
    Accepted types: jpeg, png, webp. Max 5 MB decoded. Anything else is a 400
    with a plain message naming the limit.
  - The server stores it and serves it at a stable URL. The email embeds the
    flyer above the message and links it full size. SMS cannot carry an image,
    so the text version appends the flyer link instead of dropping it.
  - A flyer with no message is allowed (the image IS the message); a broadcast
    with neither subject nor message nor image is a 400.
- `GET /api/admin/broadcasts` (admin) → `{broadcasts:[{ts, subject, message,
  image_url?, sent}]}` newest first, so she can see what she has already sent.

## Demo helpers (mock server only — NOT in production)
- `GET /api/_outbox` → `{messages:[{ts,channel:"email"|"sms",to,subject,body}]}` newest first
- `POST /api/_reset` → reseed demo data (a few sample bookings/clients)

Mock server env: `PORT` (default 4870), `ADMIN_EMAILS` (default `ebony@demo.local`),
`STRIPE_SECRET_KEY` optional (if set, real Stripe test-mode Checkout via REST).
