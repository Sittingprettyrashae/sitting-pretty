# RUNBOOK - Sitting Pretty go-live

How to take the site from the local demo (`server/server.mjs`, simulated
Stripe, demo outbox) to production: Supabase (Postgres + Auth + one edge
function named `api`) + Stripe Checkout + Resend email, optional Twilio SMS,
static frontend on GitHub Pages.

Production code lives in `supabase/`:

- `supabase/schema.sql` - tables, trigger, RLS, indexes, and the
  `bookings_overlap` exclusion constraint (database-level double-booking
  guard)
- `supabase/functions/api/` - the whole `/api/*` contract as one function
  (`index.ts` router, `bookings.ts`, `me.ts`, `cancel.ts`, `admin.ts`,
  `stripe-webhook.ts`)
- `supabase/functions/_shared/` - auth, db, catalog, notify, stripe helpers

PLACEHOLDER WARNING: Ke'Ebonie's real email is still unconfirmed. Every file
uses `ebony@demo.local` as a stand-in. Do not go live until step 8's open
items are answered by her.

Do the steps in order.

---

## 1) Ke'Ebonie creates HER OWN Stripe account

Her money must land in her bank. Nelson never routes her payouts through his
Stripe account, not even temporarily.

1. She signs up at https://dashboard.stripe.com/register with her own email,
   her legal/business info, and HER bank account for payouts.
2. In her dashboard, Developers > API keys, collect both key pairs:
   - Test mode: `sk_test_...` (secret) and `pk_test_...`
   - Live mode: `sk_live_...` and `pk_live_...` (visible after activation)
3. Only the secret key is used by this stack (Checkout sessions are created
   server-side). Start everything below in TEST mode; switch to live keys at
   the end of the test checklist.

If Nelson needs dashboard access, she can invite him as a team member
(Settings > Team). The account stays hers.

## 2) Create the Supabase project and run the schema

1. https://supabase.com > New project (free tier is fine to start). Note the
   project ref (the `xxxx` in `https://xxxx.supabase.co`), the anon public
   key, and the database password.
2. Run the schema. Either paste `supabase/schema.sql` into the dashboard SQL
   Editor and run it, or use the CLI as a migration:

   ```sh
   brew install supabase/tap/supabase        # or: npm i -g supabase
   supabase login
   cd ~/sitting-pretty-site
   supabase link --project-ref YOUR-PROJECT-REF
   mkdir -p supabase/migrations
   cp supabase/schema.sql supabase/migrations/20260802000000_init.sql
   supabase db push
   ```

3. Enable email OTP sign-in:
   - Authentication > Providers: Email stays enabled (default).
   - Authentication > Emails > Magic Link template: make sure the body
     includes `{{ .Token }}`. That token IS the 6-digit code the site's
     "enter your code" screen expects. There are no custom auth endpoints in
     production: the frontend calls `supabase.auth.signInWithOtp({ email })`
     (replaces POST /api/auth/request-code) and
     `supabase.auth.verifyOtp({ email, token, type: "email" })` (replaces
     POST /api/auth/verify).
   - Supabase's built-in mailer is rate-limited to a handful of emails per
     hour and is not for production. Authentication > SMTP Settings: point it
     at Resend SMTP (host `smtp.resend.com`, port 465, username `resend`,
     password = the Resend API key from step 3) once the Resend account
     exists.
4. Make her the admin, AFTER her first sign-in on the site (the clients row
   is created by trigger at first login). In the SQL Editor:

   ```sql
   -- PLACEHOLDER: ebony@demo.local is NOT her real email. Get it from her
   -- (step 8) before running this.
   update public.clients set is_admin = true where email = 'ebony@demo.local';
   ```

## 3) Deploy the edge function and set secrets

Deploy (from the repo root, already linked from step 2):

```sh
supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` is required: `/services` and `/availability` are public,
and Stripe calls the webhook without a Supabase JWT. Auth is enforced inside
the function (`_shared/auth.ts`) for everything that needs it.

Set secrets (test values first; replace every REPLACE):

```sh
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_REPLACE \
  STRIPE_WEBHOOK_SECRET=whsec_REPLACE \
  RESEND_API_KEY=re_REPLACE \
  NOTIFY_FROM_EMAIL="Sitting Pretty <bookings@REPLACE-WITH-CHOSEN-DOMAIN>" \
  SITE_URL=https://REPLACE-WITH-CHOSEN-DOMAIN \
  ALLOWED_ORIGIN=https://REPLACE-WITH-CHOSEN-DOMAIN
```

Notes:

- `STRIPE_WEBHOOK_SECRET` does not exist until step 4; set the rest now and
  re-run `supabase secrets set STRIPE_WEBHOOK_SECRET=...` after step 4.
- Resend: create an account at https://resend.com, verify the sending domain
  (the same domain as step 7), and create an API key. Until the domain is
  verified, `NOTIFY_FROM_EMAIL` can stay unset and the code falls back to
  Resend's shared onboarding sender, which is fine for testing only.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically
  by the edge runtime. Do not set them and never put the service role key in
  any frontend file.
- Optional SMS (only if step 8 says go):

  ```sh
  supabase secrets set \
    TWILIO_ACCOUNT_SID=ACREPLACE \
    TWILIO_AUTH_TOKEN=REPLACE \
    TWILIO_FROM_NUMBER=+1REPLACE
  ```

  Without these, every SMS is still rendered and stored in
  `notifications_log` with status `logged`, and email still sends. Nothing
  breaks by skipping Twilio.

Redeploy after any code change with the same deploy command. Logs:
`supabase functions logs api` or the dashboard's Edge Functions > api > Logs.

## 4) Stripe webhook endpoint

In HER Stripe dashboard (test mode first):

1. Developers > Webhooks > Add endpoint.
2. Endpoint URL:
   `https://YOUR-PROJECT-REF.supabase.co/functions/v1/api/stripe/webhook`
3. Events: select only `checkout.session.completed`.
4. Copy the signing secret (`whsec_...`) and store it:

   ```sh
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_REPLACE
   ```

When switching to live mode later, repeat this in live mode: live webhooks
have a different `whsec_`, and `STRIPE_SECRET_KEY` must be swapped to
`sk_live_...` at the same time.

Safety behavior baked into the webhook handler: a booking is only confirmed
when the session's `payment_status` is `paid` AND `amount_total` equals the
booking's `deposit_cents`. Anything else (unsettled payment, wrong amount,
unknown booking, replayed event) is acknowledged and logged without
confirming; check `supabase functions logs api` if a paid booking ever seems
stuck in `awaiting_deposit`.

## 5) Frontend config: swap demo API for production

The frontend reads one global, `window.SP_CONFIG`, defined in `js/config.js`
(a commented template ships in the repo). `js/api.js` uses exactly one key
today: `apiBase`, which it prefixes onto every API call. Every call path in
the frontend already starts with `/api/...`, so `apiBase` is the part BEFORE
`/api`:

Demo (what local dev uses, same-origin mock server):

```js
window.SP_CONFIG = {
  apiBase: "",
  supabaseUrl: "",
  supabaseAnonKey: ""
};
```

Production (edit `js/config.js` and commit before deploying to Pages):

```js
window.SP_CONFIG = {
  apiBase: "https://YOUR-PROJECT-REF.supabase.co/functions/v1",
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseAnonKey: "REPLACE-WITH-ANON-PUBLIC-KEY"
};
```

Note there is NO trailing `/api` on `apiBase`: the deployed function is
named `api`, so `.../functions/v1` plus the frontend's `/api/...` paths
resolves to `.../functions/v1/api/...`, which is the function's URL.

REQUIRED HTML EDIT: both `index.html` and `dashboard.html` must load the
config before the API client. In each file, add this exact line immediately
ABOVE the existing `<script src="js/api.js"></script>` tag:

```html
<script src="js/config.js"></script>
```

OPEN ITEM (dev task, blocks production sign-in): `js/api.js` does not yet
read `supabaseUrl` or `supabaseAnonKey`. It still calls the demo endpoints
`/api/auth/request-code` and `/api/auth/verify`, which the production
function answers with 410 Gone. Before go-live, `js/api.js` must be updated
so that when `supabaseUrl` is set, its two auth calls go to Supabase Auth
instead (`supabase.auth.signInWithOtp({ email })` and
`supabase.auth.verifyOtp({ email, token, type: "email" })`, step 2.3) and
the returned `access_token` is stored as `sp_token`. Everything else already
works unchanged: every other request goes to `apiBase` + the same path with
`Authorization: Bearer <sp_token>`. The anon public key is safe to publish;
data is protected by RLS plus the in-function auth checks.

## 6) Schedule the 24-hour unpaid-deposit cleanup

Her policy: deposits are due within 24 hours of booking or the appointment
is canceled. Nothing in production cancels stale `awaiting_deposit` rows by
itself, so schedule it in Postgres with pg_cron:

1. Dashboard > Database > Extensions: enable `pg_cron`.
2. SQL Editor, run once:

   ```sql
   select cron.schedule(
     'cancel-unpaid-deposits',   -- job name, visible in cron.job
     '*/30 * * * *',             -- every 30 minutes
     $$
     update public.bookings
        set status = 'canceled', canceled_by = 'admin'
      where status = 'awaiting_deposit'
        and created_at < now() - interval '24 hours';
     $$
   );
   ```

3. Verify: `select * from cron.job;` lists the job; after a run,
   `select * from cron.job_run_details order by start_time desc limit 5;`
   shows results. To remove it:
   `select cron.unschedule('cancel-unpaid-deposits');`.

Notes:

- This SQL path does not send a cancellation email (notifications are sent
  by the edge function). That is fine: the deposit email already tells the
  client the appointment is canceled if the deposit is not paid within 24
  hours. When Ebony cancels manually from the dashboard instead, the client
  does get the notice.
- The freed slot reopens automatically: availability ignores canceled rows,
  and the `bookings_overlap` constraint only applies to non-canceled rows.

## 7) GitHub Pages + custom domain + Cloudflare DNS

Hosting is GitHub Pages only (no Netlify, no Vercel).

1. Push the repo:

   ```sh
   cd ~/sitting-pretty-site
   git remote add origin git@github.com:YOUR-GITHUB-USERNAME/sitting-pretty-site.git
   git push -u origin main
   ```

2. Repo Settings > Pages > Source: Deploy from a branch, `main`, `/ (root)`.
   The site is live at
   `https://YOUR-GITHUB-USERNAME.github.io/sitting-pretty-site/` within a
   minute or two.
3. Custom domain (blocked on step 8's domain choice): buy the domain, add it
   to Cloudflare (free plan), then in repo Settings > Pages set the custom
   domain (GitHub commits a `CNAME` file).
4. Cloudflare DNS records:
   - `www` CNAME -> `YOUR-GITHUB-USERNAME.github.io`
   - apex `@`: either a CNAME (Cloudflare flattens it) to the same target, or
     GitHub Pages A records `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`.
   - Leave records DNS-only (grey cloud) until GitHub finishes issuing the
     certificate, then check Enforce HTTPS in Pages settings.
5. Update `SITE_URL`, `ALLOWED_ORIGIN` (step 3), the Stripe checkout
   redirect domain, and the Resend sending domain to match the final domain.

## 8) Still needs Ke'Ebonie's word (do not guess these)

| Item | Current placeholder | Needed |
| --- | --- | --- |
| Admin email | `ebony@demo.local` everywhere | Her real email, for step 2.4 and her dashboard login |
| Instagram handle | not on the site | Her handle, or confirmation to leave IG off |
| "Licensed cosmetologist" wording | not used yet | Confirm licensure before any such claim appears on the site |
| SMS go/no-go | SMS renders to log only | Twilio number is about $1.15/mo plus a per-message fee (roughly a cent per SMS segment; confirm current pricing at twilio.com/pricing before promising it). If no, email-only is already fully working |
| Domain name | none purchased | Her pick, needed for steps 3, 5, 7 |

---

## Test checklist (run in Stripe TEST mode before going live)

Stripe test card: `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
Decline card: `4000 0000 0000 0002`.

- [ ] Site loads from the Pages URL; services and prices match
      services-data.js.
- [ ] Sign in with a real personal email; the 6-digit code arrives (check
      spam; if nothing arrives, step 2.3 SMTP is the usual culprit).
- [ ] Book a deposit service (for example Traditional Sew In, $50 deposit):
      Stripe Checkout opens for exactly $50, pay with 4242. Booking flips to
      `confirmed`, confirmation email arrives, dashboard shows it.
- [ ] Decline card: booking stays `awaiting_deposit` and the "almost booked"
      email contains the checkout link.
- [ ] Book a no-deposit service (for example 2-Part Sew In): no payment step,
      status `request`, request email arrives.
- [ ] Overlap guard: try booking a time overlapping an existing booking; the
      slot is gone, and forcing it returns the "just taken" error. (Even two
      simultaneous submissions cannot both land: the `bookings_overlap`
      database constraint rejects the second insert and the API returns the
      same 409.)
- [ ] Cleanup job (step 6): leave a deposit booking unpaid; after 24 hours
      it flips to `canceled` and the slot reopens. To test faster,
      temporarily schedule the job with a shorter interval, then restore.
- [ ] Sunday shows closed. On a Saturday, the last offered start time equals
      18:00 minus the service duration.
- [ ] Cancel from My bookings: status `canceled`, cancellation email arrives.
- [ ] Admin: sign in with the admin email, dashboard lists all bookings.
- [ ] Admin blocks a day: it vanishes from the date picker; unblock restores
      it.
- [ ] Admin cancels a booking: client gets the cancellation notice.
- [ ] Broadcast: send a test broadcast; one row per client per channel lands
      in `notifications_log` (emails `sent`, SMS `logged` unless Twilio is
      configured).
- [ ] `notifications_log` has rows for every event above; nothing `failed`.

Going live: swap `STRIPE_SECRET_KEY` to `sk_live_...`, create the live-mode
webhook (step 4) and set its `whsec_`, redeploy nothing (secrets apply on
next invocation), then make one real booking with the cheapest deposit
service and refund it from her Stripe dashboard to confirm money reaches her
account.

---

## MIGRATION: everything moves to Ke'Ebonie's own accounts

End state: every account is hers, every bill is hers, and the developer
stays on only as an invited collaborator for maintenance. She creates and
keeps every password herself; nothing in this section ever contains a real
credential.

### GitHub (repo + Pages)

1. She creates her own GitHub account.
2. Move the repo to her: repo Settings > General > Danger Zone > Transfer
   ownership > her username. (Alternative: she creates an empty repo and the
   developer pushes `main` to it.)
3. On HER repo: Settings > Pages > Deploy from a branch, `main`, `/ (root)`,
   and re-enter the custom domain. Transfers do not always carry Pages
   settings, so re-check both after the move.
4. She invites the developer back for maintenance: Settings > Collaborators
   > Add people (Write access is enough).

### Supabase

Cleanest path: do step 2 inside HER Supabase organization from the start
(she signs up first, then invites the developer: Organization Settings >
Team > Invite). If the project ended up under the developer's org instead,
transfer it: Project Settings > General > Transfer project, into her
organization. The database, secrets, and deployed edge function move with
the project; nothing needs redeploying. Billing email on the org should be
hers.

### Stripe

Already hers if step 1 was followed: she signed up herself and completed
onboarding with her own legal info and HER bank account, so payouts go
straight to her. The developer never routes her payouts through his own
Stripe account, not even temporarily. For maintenance she invites him with
a limited role: Settings > Team, role Developer. The webhook and keys from
steps 3 and 4 keep working unchanged.

### Domain + Cloudflare DNS

1. She buys the domain in her own registrar account. A normal `.com` runs
   roughly 10 to 15 dollars a year at cost-price registrars (for example
   Cloudflare Registrar or Porkbun; confirm the current price at checkout).
2. She creates her own free Cloudflare account and adds the domain, then
   the DNS records from step 7 are recreated in her account. If Cloudflare
   is also the registrar, DNS lands in the same account automatically.
3. For maintenance she invites the developer: Manage account > Members >
   Invite, with a DNS-scoped role.

### After the moves, re-verify

- [ ] `SITE_URL` and `ALLOWED_ORIGIN` secrets still match the live domain.
- [ ] Stripe webhook endpoint URL still points at the Supabase project URL
      and the live `whsec_` is set.
- [ ] `js/config.js` still points at the right project ref.
- [ ] The pg_cron cleanup job (step 6) still shows in `cron.job`.
- [ ] One end-to-end booking with the cheapest deposit service, refunded
      from her Stripe dashboard afterward.
- [ ] She has two-factor auth on GitHub, Supabase, Stripe, Cloudflare, and
      her email.
