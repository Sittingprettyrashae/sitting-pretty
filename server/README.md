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
| `DEMO` | `1` (on) | Demo helper endpoints `GET /api/_outbox` and `POST /api/_reset` are on by default so the demo login flow works. Set `DEMO=0` to disable both (they 404). |

Note: the `/api/stripe/webhook` endpoint does NOT verify the Stripe signature.
That is fine for this local demo; production must verify `Stripe-Signature`.

## Demo logins

Any email address works. Signing in creates the client account.

1. Enter an email on the site and request a code.
2. The 6-digit code is "emailed" to the outbox: open `/api/_outbox` and read the
   newest message. Codes expire after 10 minutes, 5 attempts max.
3. `ebony@demo.local` signs in as the admin (Ke'Ebonie Hill) and can use the
   dashboard.

Code requests are rate limited: 5 per email and 5 per IP every 15 minutes,
then `429`.

## Security notes

- Static file serving resolves the real on-disk path and refuses anything
  outside the project root or inside `server/`, `supabase/`, `.git`, or any
  dotfile path. The check is per path segment and case-insensitive, so
  `/Server/db.json` is just as blocked as `/server/db.json` on macOS.
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
- `server/db.json` holds live session tokens and client contact info. It is
  gitignored and must never be committed or published.

## Where things live

- `server/db.json`: all data (clients, bookings, sessions, blocked days,
  outbox, broadcasts). JSON file, saved automatically a moment after each
  change. Delete it to start fresh. Never commit it (see `.gitignore`).
- Outbox: every email and SMS the system "sends" is stored newest first,
  capped at 200 messages. Read it at `GET /api/_outbox` (requires `DEMO` on).
- `POST /api/_reset`: reseeds the demo data (3 demo clients, 5 sample bookings
  across the next week, and the admin account). Also signs everyone out.
  Requires `DEMO` on.
- Service catalog: derived at boot from `services-data.js` in the project root,
  including durations and deposit amounts, so the client and server always
  agree. Restart the server after editing that file.
