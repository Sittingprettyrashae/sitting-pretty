# Sitting Pretty local demo server

Zero-dependency Node backend for the Sitting Pretty booking platform. Serves the
static site and the full `/api/*` contract from `API.md` on one origin.

## Run

```
node server/server.mjs
```

Requires Node 20 or newer. No npm install, no build step.

- Site: http://localhost:4870/
- Ebony's dashboard: http://localhost:4870/dashboard.html
- Message outbox (demo email + SMS log): http://localhost:4870/api/_outbox

The server listens on **127.0.0.1 only** (loopback). It is never reachable from
other machines on the network.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4870` | HTTP port (loopback only) |
| `ADMIN_EMAILS` | `ebony@demo.local` | Comma separated list of admin logins |
| `STRIPE_SECRET_KEY` | unset | If set, deposits create real Stripe Checkout sessions (use a test key). If unset, checkout happens at the built-in `/demo-checkout` page with a simulated payment. |
| `GOOGLE_CLIENT_ID` | unset | Set together with the secret to run the real Google OAuth flow. |
| `GOOGLE_CLIENT_SECRET` | unset | If either is missing, Google sign-in uses the built-in `/demo-google` account chooser instead. Authorized redirect URI for Google: `http://localhost:4870/api/auth/google/callback`. |
| `DEMO` | `1` (on) | Demo helper endpoints `GET /api/_outbox` and `POST /api/_reset` are on by default so the demo login flow works. Set `DEMO=0` to disable both (they 404). |
| `DB_PATH` | `server/db.json` | Where the data file lives. Point a second copy of the server at another file (with another `PORT`) to test without touching the demo's data. |

Note: the `/api/stripe/webhook` endpoint does NOT verify the Stripe signature.
That is fine for this local demo; production must verify `Stripe-Signature`.

## Demo logins

Three ways in, all ending at the same `{token, client}` shape.

**1. Email and password**

- `POST /api/auth/signup` `{email, password, name?, phone?}` makes the account.
  Passwords need 8 characters or more and cannot be one of the well-known easy
  ones. An email that already has an account gets a `409` pointing at sign-in.
- `POST /api/auth/login` `{email, password}` signs in. A wrong password and an
  email with no account return the exact same `401`, so the endpoint never
  reveals which addresses are real.
- The seeded demo client **`tasha@demo.local` has the password
  `SittingPretty2026`**, so the password path is testable the moment the server
  boots. Every other seeded client is code-only on purpose (see migration below).
- Sign-in is rate limited: 8 **failed** attempts per email and per IP every 15
  minutes, then `429` with a wait message. Correct passwords never count against
  it, so a client who knows her password is never locked out by someone else's
  guessing.

**2. Google**

- `GET /api/auth/google/start?redirect=/index.html` redirects into the Google
  flow and comes back to `GET /api/auth/google/callback`, which finishes at
  `<redirect>#sp_token=<token>`.
- Without Google credentials the callout goes to `/demo-google`, a clearly
  labelled practice version of the Google account chooser with a few made-up
  accounts plus a free email field. Nothing contacts Google.
- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and the same routes run the
  real authorization-code exchange against Google, require `email_verified` on
  the id_token, and the demo chooser turns itself off. Nothing else changes.
- Signing in with Google on an email that already has an account signs into that
  same account and leaves its password alone.

**3. Email code (the original flow, still there)**

1. Enter an email on the site and request a code.
2. The 6-digit code is "emailed" to the outbox: open `/api/_outbox` and read the
   newest message. Codes expire after 10 minutes, 5 attempts max.
3. `POST /api/auth/request-code` takes an optional `purpose` of `login` or
   `reset`. It only changes the wording of the message, nothing else.
4. `POST /api/auth/set-password` `{password}` (signed in) finishes a reset and
   is also how a code-only account adds a password.

`ebony@demo.local` signs in as the admin (Ke'Ebonie Hill) and can use the
dashboard, by any of the three ways above.

Code requests are rate limited: 5 per email and 5 per IP every 15 minutes,
then `429`.

## Her hours

Hours are data, not code. `db.hours` holds all seven days
(`{weekday, closed, open, close}`, weekday 0 is Sunday), and the availability
engine, the dashboard, and the hours table on the public site all read that one
record. Her site can never advertise hours she does not work.

- `GET /api/hours` is public. `GET /api/admin/hours` and `PUT /api/admin/hours`
  are hers.
- Seeded with her real schedule: Sunday closed, Monday to Friday 09:00 to 20:00,
  Saturday 09:00 to 18:00. She can change any of it from her phone.
- Saving checks all seven days are there once each, that closing is later than
  opening, and that times land on the hour or the half hour. Every refusal is a
  plain sentence naming the day, because she is the one reading it.
- A `db.json` from an older build has no hours at all. It gets her real ones on
  load, and so does a record that has been damaged: the shop is never left with
  no hours.

**Changing hours never touches an existing booking.** Appointments already on
the books were promised to a client, so nothing is cancelled, moved, or hidden.
Only new bookings are held to the new hours. The `PUT` response carries
`affected`: the non-cancelled future bookings that now sit outside her hours, so
the dashboard can show her which ones she may want to text about. Verified end
to end: a 7:00 PM appointment booked on a Wednesday is still on the dashboard,
still on the client's own list, and still at 7:00 PM after that Wednesday is
closed, while a new 7:00 PM booking that day is refused.

## Broadcast and flyers

`POST /api/admin/broadcast` `{subject, message, image?}` sends one message to
every client, email and SMS, and logs it. `GET /api/admin/broadcasts` lists what
she has already sent, newest first.

- `image` is a flyer as a data URL. JPG, PNG, or WEBP, 5 MB or smaller once
  decoded. The bytes have to actually be that kind of image: a file that only
  claims to be a PNG is refused.
- Flyers are written to `uploads/` at the project root with a name the server
  invents, and served back at `/uploads/<name>`. That directory is gitignored,
  so flyers never end up in the repo or on the published site.
- The email puts the flyer above her message and links it full size. A text
  message cannot carry a picture, so the SMS gets the flyer link appended
  instead of losing it.
- A flyer with no words is fine, the picture is the message. Nothing at all
  (no subject, no message, no flyer) is refused.
- Only this route takes a bigger request body (8 MB, enough for a 5 MB flyer
  once it is base64). Everything else is still capped at 1 MB.

## Migration: accounts made before passwords existed

Nothing breaks. A client record with no password (every account created by the
old code-only flow) keeps signing in by email code exactly as before. If she
tries the password form, `POST /api/auth/login` answers `409` with
`needs_password_setup: true` so the UI can walk her through one code sign-in and
then `POST /api/auth/set-password`. A `db.json` written by an older build is
brought up to shape on load: existing clients get `password_hash: null`,
`auth_provider: "code"`, and old sessions stay valid and pick up the 90-day
sliding expiry on their next request.

## Security notes

- Passwords are stored as `scrypt$N$salt$hash` with a fresh 16-byte salt per
  client (N=16384, r=8, p=1) and compared with `timingSafeEqual`. The plaintext
  is never stored, never logged, and never returned; the hash never leaves the
  server. An unknown email is still checked against a throwaway hash so a wrong
  password and a missing account take the same amount of time.
- Sessions last 90 days and slide: every authenticated request pushes the expiry
  back out, so repeat clients stay signed in. Tokens are opaque random values
  kept server side in `db.json`. `POST /api/auth/logout` deletes the current one,
  and a password change deletes every session for that client and issues a fresh
  token, so an old token cannot outlive a password change.
- `POST /api/auth/set-password` returns `{client, token}`. The extra `token` is
  on top of the API.md contract and is there because the old token is
  deliberately dead by the time the response is written.
- The Google round trip carries a `state` value: unguessable, stored server
  side, single use, 10 minute expiry, and checked in the callback. That is the
  CSRF defense the real Google flow needs, so the demo runs it too. The
  `redirect` is only ever a same-origin path, so it cannot be pointed at another
  site.
- The demo account chooser is not a back door: as soon as `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` are set, `/demo-google` stops serving accounts and the
  callback only accepts a real Google authorization code.
- `client.auth_provider` records the way this client most recently signed in
  (`password`, `google`, or `code`). `client.has_password` is the flag to branch
  the UI on, and it stays true after a Google or code sign-in.
- Static file serving resolves the real on-disk path and refuses anything
  outside the project root or inside `server/`, `supabase/`, `.git`, or any
  dotfile path. The check is per path segment and case-insensitive, so
  `/Server/db.json` is just as blocked as `/server/db.json` on macOS. Adding
  `uploads/` did not loosen any of that: it is an ordinary folder inside the
  root, and the refusals above were re-checked after the change.
- Flyers are only ever written by the server, under a name the server picks,
  with an extension that matches what the bytes really are (the JPG, PNG, and
  WEBP signatures are checked, not the label on the data URL). Nothing a caller
  sends decides the filename or the path. Every static response now carries
  `X-Content-Type-Options: nosniff`, so an uploaded file cannot be talked into
  running as script or markup.
- Checkout endpoints (`GET /api/checkout/:id`, `POST /api/checkout/:id/pay`)
  require either the booking owner's auth token (admin also allowed) or the
  one-time `pay_token` that the server generates with each checkout session and
  embeds in the `/demo-checkout` URL. Anything else gets `403`.
- `GET /api/me` includes a `checkout_url` on each `awaiting_deposit` booking so
  a client can finish paying later. If the stored checkout session is missing
  or stale the server mints a fresh one. (Booking objects gain this optional
  `checkout_url` field on top of the API.md contract.)
- Deposit deadline enforcement: her policy is that deposits are due within 24
  hours of booking. A sweeper runs at boot, every 15 minutes, and before
  availability/bookings reads; it cancels `awaiting_deposit` bookings older
  than 24 hours (`canceled_by: "system"`) and sends the client a cancellation
  notice about the unpaid deposit.
- `server/db.json` holds live session tokens, password hashes, and client
  contact info. It is gitignored and must never be committed or published.

## Where things live

- `server/db.json`: all data (clients, bookings, sessions, hours, blocked days,
  outbox, broadcasts). JSON file, saved automatically a moment after each
  change. Delete it to start fresh. Never commit it (see `.gitignore`).
- `uploads/`: flyers sent with a broadcast, served at `/uploads/<name>`.
  Gitignored. Safe to empty at any time; only past broadcasts point at it.
- Outbox: every email and SMS the system "sends" is stored newest first,
  capped at 200 messages. Read it at `GET /api/_outbox` (requires `DEMO` on).
- `POST /api/_reset`: reseeds the demo data (3 demo clients, 5 sample bookings
  across the next week, and the admin account). Also signs everyone out, puts
  `tasha@demo.local` back to the demo password above, puts her hours back to
  the seeded schedule, and clears the rate-limit counters. Requires `DEMO` on.
- Service catalog: derived at boot from `services-data.js` in the project root,
  including durations and deposit amounts, so the client and server always
  agree. Restart the server after editing that file.
