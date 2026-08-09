# RUNBOOK - Sitting Pretty go-live

How to take the site from the local demo (`server/server.mjs`, simulated
Stripe, demo outbox) to production: Supabase (Postgres + Auth + one edge
function named `api`) + Stripe Checkout + Resend email, optional Twilio SMS,
static frontend on GitHub Pages.

Production code lives in `supabase/`:

- `supabase/schema.sql` - tables, trigger, RLS, indexes, the `bookings_overlap`
  exclusion constraint (database-level double-booking guard), her editable
  `hours` record, and the `flyers` Storage bucket
- `supabase/functions/api/` - the whole `/api/*` contract as one function
  (`index.ts` router, `auth.ts`, `bookings.ts`, `me.ts`, `cancel.ts`,
  `admin.ts`, `stripe-webhook.ts`)
- `supabase/functions/_shared/` - auth, db, catalog, hours, flyer, notify,
  stripe helpers

Clients get three ways in: a password they pick, Sign in with Google, or the
6-digit email code. Setting up the first two is step 2b.

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

   **Whose account is the CLI on?** `supabase login` on the developer's machine
   is almost certainly still HIS account, and linking there would put her
   booking platform in his org, which is the whole thing this handoff exists to
   avoid. Check with `supabase projects list`: if her project is not in it, you
   are on the wrong account.

   Do not run `supabase login` to fix it, because that replaces his session and
   he has other clients in there. Have her generate an access token
   (Supabase dashboard, account settings, Access Tokens) and scope it to just
   these commands:

   ```sh
   export SUPABASE_ACCESS_TOKEN=sbp_...      # hers, this shell only
   supabase projects list                     # should now show HER project
   ```

   ```sh
   brew install supabase/tap/supabase        # or: npm i -g supabase
   cd ~/sitting-pretty-site
   supabase link --project-ref YOUR-PROJECT-REF
   mkdir -p supabase/migrations
   cp supabase/schema.sql supabase/migrations/20260802000000_init.sql
   supabase db push
   ```

   Re-running `schema.sql` on a database that already has data is safe: every
   statement is guarded, and the last block recomputes `has_password` and
   `auth_provider` on every existing client. That is how a project created
   before password/Google sign-in gets upgraded.

3. Sign-in setup (password, Google, email code) is its own section: step 2b.
4. Real email delivery. Supabase's built-in mailer is rate-limited to a
   handful of messages per hour and is not for production, and every
   sign-in method here depends on email. Authentication > SMTP Settings:
   point it at Resend SMTP (host `smtp.resend.com`, port 465, username
   `resend`, password = the Resend API key from step 3) once the Resend
   account exists.
5. Make her the admin, AFTER her first sign-in on the site (the clients row
   is created by trigger at first login). In the SQL Editor:

   ```sql
   -- Use HER Gmail address, confirmed 2026-08-09. It is deliberately not
   -- written in this repo (public: committing it invites scrapers), so copy
   -- it from server/.env.local, which is gitignored and already has it.
   update public.clients set is_admin = true where email = '<her address from server/.env.local>';
   ```

## 2b) Turn on all three ways to sign in

Goal, in her words: clients should be able to make a profile with Google
sign-in, or with their own email and password, so they are not typing a
one-time code every single visit.

All three run on Supabase Auth. The browser calls Supabase directly, gets an
access token back, and sends that token to the booking API. Nothing in this
project stores a password: Supabase holds the hash, and the `clients` table
only records `has_password` and `auth_provider` so the site knows which
buttons to show. Whichever way someone signs in, they land on the same
client record and the same booking history (schema.sql `sp_sync_client`).

Before starting, know which account is doing what. Full ownership table at
the end of this section, but the short version: the Google Cloud project has
to be created while signed into HER Google account, and everything inside
the Supabase dashboard can be done by the developer once she has invited him
to her organization.

Dashboard menu names below match the current Supabase dashboard. Older
projects label the same page "Authentication > Providers" instead of
"Authentication > Sign In / Providers".

### 2b.1 Email and password

Authentication > Sign In / Providers > Email:

1. Leave the Email provider **enabled**. This one provider covers both the
   password sign-in and the 6-digit code, so turning it off breaks both.
2. **Confirm email: leave it ON.** See 2b.2 for why, and for what it costs.
3. Minimum password length: set **8**, which matches what API.md promises
   clients ("at least 8 characters").
4. If your project shows "Prevent use of leaked passwords" or a password
   requirements selector, turning on the leaked-password check is worth it
   and costs nothing at sign-up speed. If the option is not there, skip it.
5. Leave "Secure email change" on, so changing an address needs both the old
   and the new inbox.
6. Sign-ups must stay allowed. If Authentication > Sign In / Providers shows
   an "Allow new users to sign up" toggle at the top, it must be on, or no
   new client can create a profile.

### 2b.2 The Confirm email decision, and why

**Pick: Confirm email ON.** Three reasons, in order of how much they matter:

1. It is what makes "sign in with Google" safe on an account that already
   exists. Supabase links a Google sign-in to an account with the same email
   address, and the Supabase docs are explicit that linking to an
   *unverified* address is unsafe because of pre-account-takeover attacks.
   With confirmations turned off, every password sign-up is treated as
   verified even though nobody proved they can open that inbox, so a
   stranger could register a client's address first and quietly own the
   account that client's Google sign-in later lands in.
2. Every deposit link, confirmation, and cancellation notice this business
   sends goes to that address. A typo at sign-up with confirmations off
   creates a client who never receives her Stripe deposit link and shows up
   thinking she is booked.
3. The cost is one email at sign-up and never again, which is exactly the
   thing she asked for. The code-every-time complaint is about repeat
   visits, and repeat visits are covered by the session settings in 2b.5.

The one real trade-off: with Confirm email on, `supabase.auth.signUp()`
returns a user but **no session**. The sign-up screen has to say "check your
email to finish setting up your profile" rather than dropping straight into
booking. That is a frontend detail, and it is called out in step 5.

If she ever insists on instant sign-up with no confirmation email, turning
Confirm email off is one toggle, but do not do it while Google sign-in is
enabled, for reason 1 above.

### 2b.3 Site URL and the redirect allow-list

Authentication > URL Configuration. This is what makes confirmation links,
password-reset links, and the return trip from Google land back on the site
instead of on `localhost`.

**Site URL** (the default landing spot when no redirect is given): set it to
the live site. Before the custom domain exists that is the GitHub Pages URL,
including the repo folder:

```
https://YOUR-GITHUB-USERNAME.github.io/sitting-pretty-site/
```

After the custom domain is live (step 7), change it to
`https://YOUR-DOMAIN.com/` and leave the Pages URL in the allow-list below.

**Redirect URLs** (allow-list, one entry per line). Add all of these:

```
https://YOUR-GITHUB-USERNAME.github.io/sitting-pretty-site/**
https://YOUR-DOMAIN.com/**
https://www.YOUR-DOMAIN.com/**
http://localhost:4870/**
```

Rules that bite people here:

- `*` stops at `/` and `.`; `**` crosses them. A GitHub Pages project site
  lives under a folder, so the `/**` ending is required, not decorative.
- Trailing slashes are compared literally. `.../sitting-pretty-site` and
  `.../sitting-pretty-site/` are different entries; the `/**` patterns above
  cover the pages under the folder.
- Query strings are ignored when matching, so no `?` entries are needed.
- `http://localhost:4870/**` is the local demo port. Remove it before going
  live if she prefers a tight list.

### 2b.4 Sign in with Google

Two consoles, in this order: build the credential in Google, paste it into
Supabase.

**Google side.** She must be signed into HER Google account for all of this.
The name and logo configured here are what her clients read on the Google
permission screen, so it should say her business, not a developer's.

1. Create a project at https://console.cloud.google.com/home/dashboard. Name
   it something recognizable, for example `sitting-pretty-booking`.
2. Configure the consent screen at
   https://console.cloud.google.com/auth/overview:
   - User type: **External** (her clients are ordinary Google users, not
     members of a Workspace organization).
   - Branding, at https://console.cloud.google.com/auth/branding, fill:
     - App name: the salon name clients will recognize
     - User support email: her business email
     - App logo: optional, and only worth adding if she has a square logo
     - App home page / privacy policy / terms links: optional for the basic
       scopes below; if she fills any of them, the matching domain has to be
       listed under Authorized domains on the same page
     - Developer contact email: hers
   - Data Access (scopes): only these three, no others:
     - `openid` (this one is typed in by hand)
     - `.../auth/userinfo.email`
     - `.../auth/userinfo.profile`
   - **No Google verification review is needed.** Basic email and profile
     scopes are non-sensitive. Adding anything from Google's sensitive or
     restricted lists is what triggers a review, so do not add scopes this
     project does not use. (Submitting the logo for brand verification is
     separate and optional, and takes several business days.)
3. Create the credential at https://console.cloud.google.com/auth/clients:
   - Create client > Application type: **Web application**.
   - Name: anything, for example `sitting-pretty-web`.
   - Authorized JavaScript origins (origins only, no paths):
     ```
     https://YOUR-GITHUB-USERNAME.github.io
     https://YOUR-DOMAIN.com
     ```
   - **Authorized redirect URIs** - this is the one that must be exact. It
     is not the website address. It is the Supabase auth callback, shaped
     like this:
     ```
     https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
     ```
     Do not type it from memory. Copy the real one: Supabase dashboard >
     Authentication > Sign In / Providers > Google, where it is shown as a
     read-only "Callback URL (for OAuth)" field with a copy button. Paste
     that exact string into Google. A single character off, or a missing
     `/auth/v1/callback`, produces Google's `redirect_uri_mismatch` error at
     sign-in, and that error is the first thing to check if Google sign-in
     ever stops working.
   - Save, then copy the generated **Client ID** and **Client secret**. The
     secret is shown once; if it is lost, generate a new one rather than
     guessing.

**Supabase side.** Authentication > Sign In / Providers > Google:

1. Enable the Google provider.
2. Client ID (for OAuth): paste the client ID from Google.
3. Client Secret (for OAuth): paste the client secret from Google.
4. Save. Nothing needs redeploying; the change is live immediately.

Then confirm the allow-list from 2b.3 contains the page Google should return
to, because the frontend passes it as `redirectTo`:

```js
supabase.auth.signInWithOAuth({
  provider: "google",
  options: { redirectTo: window.location.origin + window.location.pathname },
});
```

What happens on an account she already had: if a client used the email code
before and now taps Sign in with Google with the same address, Supabase
links the Google identity to the existing account instead of making a second
one, so her old bookings are still there. The database keeps up on its own -
`auth_provider` flips to `google` the moment the link happens (schema.sql
`on_auth_user_updated`), and the API repairs any row that somehow drifted on
the next request (`_shared/auth.ts`).

### 2b.5 Staying signed in

Defaults are already what she wants; the job here is mostly not breaking
them.

- **Server side**, Authentication > Sessions:
  - Leave "Time-box user sessions" **empty** and "Inactivity timeout"
    **empty**. By default a Supabase session lasts indefinitely and a person
    can be signed in on several devices, which is the behavior a booking
    site wants. Both fields, and "Single session per user", are Pro-plan
    features anyway; on the free plan there is nothing to set.
  - If she is on Pro and wants the 90-day sliding window API.md describes,
    set Inactivity timeout to 90 days and still leave the time-box empty.
    Do not set a time-box: it signs people out mid-booking on a fixed clock.
  - Access token (JWT) expiry: leave the default of 1 hour. This is not how
    long someone stays signed in; the library silently renews it in the
    background. Session settings are also applied at the next renewal, not
    retroactively, so a change here shows up within about an hour.
- **Browser side**, in the supabase-js client the frontend creates:

  ```js
  const sb = supabase.createClient(SP_CONFIG.supabaseUrl, SP_CONFIG.supabaseAnonKey, {
    auth: {
      persistSession: true,      // keep the session in localStorage
      autoRefreshToken: true,    // renew the hourly token by itself
      detectSessionInUrl: true,  // pick up the return from Google
      flowType: "pkce",          // safer OAuth for a static site
    },
  });
  ```

  The first three are the defaults; they are written out so nobody
  "cleans them up" later. Because the access token is renewed roughly every
  hour, the app must read the current token from supabase-js at request time
  rather than caching one forever in `localStorage`.

### 2b.6 Email templates

Authentication > Emails > Templates. Three of them matter here.

1. **Confirm sign up** - leave the default `{{ .ConfirmationURL }}` link.
   The client taps the button in the email and comes back to the Site URL
   signed in. Reword the copy in her voice if you like; keep the variable.
2. **Magic Link (or OTP)** - the body must contain `{{ .Token }}`, which
   renders the 6-digit code. That code is what the site's existing "enter
   your code" screen expects, and it is the fallback for anyone who does not
   want a password or a Google account.
3. **Reset password** - replace the `{{ .ConfirmationURL }}` link with
   `{{ .Token }}` so a reset arrives as a 6-digit code too. Two reasons:
   the site already has a code box, and one-time links get burned by email
   scanners and inbox previews before the client ever taps them. The flow
   becomes: `resetPasswordForEmail(email)` sends the code,
   `verifyOtp({ email, token, type: "recovery" })` signs her in, then
   `updateUser({ password })` saves the new password. `has_password` flips
   to true by itself.

Keep the wording warm and plain, and do not add fees, policies, or promises
to these emails; they are transactional.

### 2b.7 What the frontend calls (developer reference)

There are no custom sign-in endpoints in production. API.md's auth section
maps onto supabase-js like this:

| API.md | Production call |
| --- | --- |
| `POST /api/auth/signup` | `supabase.auth.signUp({ email, password, options: { data: { name, phone } } })` |
| `POST /api/auth/login` | `supabase.auth.signInWithPassword({ email, password })` |
| `GET /api/auth/google/start` | `supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } })` |
| `GET /api/auth/google/callback` | handled by Supabase, then by supabase-js on the page it returns to |
| `POST /api/auth/request-code` | `supabase.auth.signInWithOtp({ email })`, or `resetPasswordForEmail(email)` when the purpose is a reset |
| `POST /api/auth/verify` | `supabase.auth.verifyOtp({ email, token, type: "email" })`, or `type: "recovery"` for a reset code |
| `POST /api/auth/set-password` | `supabase.auth.updateUser({ password })` |
| `POST /api/auth/logout` | `supabase.auth.signOut()` **and** `POST /api/auth/logout` |

Two server endpoints do still exist, in `supabase/functions/api/auth.ts`:

- `POST /api/auth/bootstrap` `{name?, phone?}` -> `{client}`. Call it once
  after every successful sign-in or sign-up. It guarantees the `clients` row
  exists, attaches a first-time Google sign-in to the account she already
  had, seeds name and phone from the sign-up form without ever overwriting a
  profile she has edited, and returns the `client` object so the frontend
  can hold the same `{token, client}` pair the demo uses.
- `POST /api/auth/logout` -> `{ok:true}`. `signOut()` clears the browser but
  the refresh token stays usable; this revokes it for real. Call both.

Every other `/api/auth/*` path answers `410` with the exact supabase-js call
that replaced it, so an old build fails loudly instead of quietly doing
nothing.

The `client` object the API returns now carries `has_password` and
`auth_provider` (`password | google | code`) so the UI can offer the right
thing: a password box for someone who has one, a "set a password so you skip
the code next time" nudge for someone who does not.

### 2b.8 Who has to do what

| Step | Who | Why it cannot be delegated |
| --- | --- | --- |
| Create the Google Cloud project, consent screen, branding, and OAuth client (2b.4) | **Ke'Ebonie**, signed into her own Google account | The consent screen shows her business name and support email to her clients, and Google ties the project to the account that creates it |
| Copy the Google client ID and secret to whoever finishes the setup | **Ke'Ebonie** | Only she can see the secret at creation time |
| Own the Supabase organization and its billing | **Ke'Ebonie** | Same reason as Stripe: it is her business account, not the developer's |
| Everything inside the Supabase dashboard: Email provider, Confirm email, URL configuration, Google provider fields, sessions, email templates, SQL, deploys (2b.1, 2b.3, 2b.5, 2b.6, and pasting the Google keys in 2b.4) | **Developer**, as an invited member | Organization Settings > Team > Invite gives him access without her ever sharing a password |
| Own the domain and Cloudflare account (step 7) | **Ke'Ebonie** | The redirect allow-list and Site URL point at a domain she controls |

She should never send a password to anyone. Every account above supports
inviting a collaborator, and every invitation can be revoked later from the
same screen.

---

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

- Optional, all with sensible defaults:

  ```sh
  supabase secrets set \
    HOLD_MINUTES=15 \
    OWNER_EMAIL=REPLACE-WITH-HER-ADDRESS \
    OWNER_PHONE=+1REPLACE
  ```

  - `HOLD_MINUTES` is how long a slot stays reserved while a client is on the
    Stripe page. Default 15, which is the number API.md states and the number
    the booking sheet tells her.
  - `OWNER_EMAIL` / `OWNER_PHONE` are where owner alerts go ("What Ebony is
    told" in API.md). Leave them unset and the alerts go to the admin account
    instead, the row you granted `is_admin` in step 2. Set them when you want
    her alerts somewhere other than her sign-in address. Owner alerts are
    never sent to a client.

Redeploy after any code change with the same deploy command. Logs:
`supabase functions logs api` or the dashboard's Edge Functions > api > Logs.

## 3b) Her hours and her flyers (things she changes herself)

Two things in this system belong to Ke'Ebonie, not to whoever is maintaining
the code. Both are set from her dashboard on her phone.

### Her hours are data, never code

Her working week lives in the `public.hours` table, one row per weekday, and
that single record feeds all three places hours show up:

- the hours table on the public site (`index.html` reads `GET /api/hours`)
- which days the booking sheet offers (`js/booking.js`)
- what times the server will actually accept (`supabase/functions/api/bookings.ts`)

So the site can never advertise a day she has closed.

**If she wants different hours, she opens her dashboard and saves them.
Nobody edits a file.** There is no weekday written into the code anywhere; the
values in `schema.sql` and in the static markup of `index.html` are only the
DEFAULT she started with (Sunday closed, Monday to Friday 09:00-20:00,
Saturday 09:00-18:00, from her StyleSeat), used to seed a brand new database
and to keep the page readable before the real hours load.

Two things worth telling her once:

- Changing her hours never moves an appointment that is already booked. Those
  times were promised to a client. If she narrows a day, the save hands back
  the upcoming appointments that now sit outside her hours so she can decide
  herself which to move and which to keep.
- Times save on the hour or the half hour, because appointments start every
  30 minutes.

To read the current record without the dashboard:

```sql
select * from public.hours order by weekday;
```

### Flyer images: where they live and what they cost

When she attaches a flyer to a broadcast, the picture is uploaded once to
Supabase Storage and the email points at it. It is not attached to each
message. One upload, one link, every client sees the same flyer.

- Bucket: `flyers`, created by `supabase/schema.sql`. Public on purpose, so
  the picture loads inside an email months later. A signed URL would expire
  and leave a broken image in a message she already sent.
- Path: `YYYY-MM-DD/<random-uuid>.<jpg|png|webp>`, so nothing she typed ever
  becomes a guessable filename.
- Public URL:
  `https://YOUR-PROJECT-REF.supabase.co/storage/v1/object/public/flyers/...`
- Only she can put a file there. The upload runs inside the edge function
  with the service role key after the admin check; there is no browser upload
  path and no policy granting one.
- Limits, enforced in `_shared/flyer.ts`: JPG, PNG, or WEBP, 5 MB max. A
  bigger or wrong-type file gets one plain message and nothing is sent to
  anybody.
- Browse or delete them in the dashboard: Storage > flyers.

Cost, on Supabase's Free plan: 1 GB of file storage and 5 GB of egress a
month, per https://supabase.com/pricing (check the page, plans change).

What that means in her terms. Flyers off a phone are usually well under 1 MB,
so 1 GB holds roughly a thousand of them. Egress is counted each time a
client's mail app loads the picture: a 1 MB flyer sent to 60 clients who all
open it is about 60 MB, so she could send a flyer a week for a year and still
be nowhere near 5 GB. Nothing here needs a paid plan for a one-chair salon.

If storage ever does fill up, delete old flyers in Storage > flyers, or move
to Pro. Do not delete a flyer from a message she sent recently: the picture
in that email would go blank.

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

Safety behavior baked into the webhook handler. The webhook is the ONLY
place a deposit turns a held slot into an appointment, and it does so only
when the session's `payment_status` is `paid`, `amount_total` equals the
deposit that was quoted, and the hold has not run out. Anything else
(unsettled payment, wrong amount, unknown session, replayed event) is
acknowledged and logged, and nothing is created or changed. Money that lands
on an appointment that is not taking any, or on a hold that already expired,
raises a refund alert to Ebony instead of quietly booking something; check
`supabase functions logs api` if a paid deposit ever seems to have produced
no booking.

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
read `supabaseUrl` or `supabaseAnonKey`. Its auth calls still go to the demo
endpoints, which the production function answers with 410 Gone naming the
replacement. Before go-live, when `supabaseUrl` is set, `js/api.js` must
create a supabase-js client with the options in step 2b.5 and route sign-in
through it, per the table in step 2b.7:

- password sign-up -> `signUp({ email, password, options: { data: { name, phone } } })`.
  With Confirm email on (step 2b.2) this returns **no session**, so the UI
  says "check your email to finish setting up your profile" instead of
  continuing into booking.
- password sign-in -> `signInWithPassword`. Google -> `signInWithOAuth`, which
  navigates away and comes back with the session in the URL, so the page must
  finish sign-in on load, not only on button click.
- code sign-in and password reset -> `signInWithOtp` / `resetPasswordForEmail`
  then `verifyOtp` then `updateUser({ password })`.
- after ANY of them succeed, call `POST /api/auth/bootstrap` (passing the
  sign-up form's `name` and `phone` when there are any) and keep the `client`
  it returns. That is what creates or links the client record.
- the token to send as `Authorization: Bearer` is
  `(await sb.auth.getSession()).data.session.access_token`, read fresh each
  time. It rotates about hourly, so a copy cached in `localStorage` at
  sign-in goes stale and starts returning 401.
- sign out -> `signOut()` **and** `POST /api/auth/logout`.

Everything else already works unchanged: every other request goes to
`apiBase` + the same path with the bearer token. The anon public key is safe
to publish; data is protected by RLS plus the in-function auth checks.

## 6) Schedule the expired-hold cleanup

The deposit is what books the spot. A service with a published deposit does
not put an appointment on her calendar: it puts a **hold** on the slot for 15
minutes while the client pays (API.md, POST /api/bookings). Nobody else can
take that time in the meantime, and the appointment appears only when the
money clears. An abandoned checkout has to give the time back.

Three things already do that, so a slot is never stuck:

- availability only ever counts holds that have not run out yet, so an
  expired hold stops blocking the time the moment it expires;
- the `sp_slot_guard` trigger clears that day's expired holds before any new
  claim is checked, so the `holds_overlap` constraint can never refuse a slot
  that is really free;
- the edge function sweeps expired holds before every availability, `/me`,
  booking, and dashboard read.

This job is the housekeeping layer on top: it keeps the table from carrying
rows nobody will ever look at again, including on days with no traffic.

1. Dashboard > Database > Extensions: enable `pg_cron`.
2. SQL Editor, run once:

   ```sql
   select cron.schedule(
     'clear-expired-holds',      -- job name, visible in cron.job
     '*/5 * * * *',              -- every 5 minutes
     $$ delete from public.holds where expires_at <= now(); $$
   );
   ```

3. Verify: `select * from cron.job;` lists the job; after a run,
   `select * from cron.job_run_details order by start_time desc limit 5;`
   shows results. To remove it:
   `select cron.unschedule('clear-expired-holds');`.

### The old 24-hour unpaid-deposit job

Earlier versions of this runbook scheduled a second job that canceled stale
`awaiting_deposit` bookings in SQL. Do not add it, and remove it if it is
still there:

```sql
select cron.unschedule('cancel-unpaid-deposits');
```

Two reasons. Under the hold model nothing new ever reaches
`awaiting_deposit`, because no appointment is created before the deposit is
paid. And the SQL job could not send a message, so an appointment came off
the calendar without the client or Ebony being told. The edge function now
does that sweep instead (`_shared/deposits.ts`): it runs before every
availability, `/me`, booking, and dashboard read, cancels anything left
unpaid past 24 hours, tells the client why, and tells Ebony the slot
reopened. If she still had unpaid bookings on the books from before the hold
model, the first page load after deploying clears them and sends both
notices.

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
| Admin email | `ebony@demo.local` everywhere | Her real email, for step 2.5 and her dashboard login |
| Google Cloud project | none | She creates it in her own Google account (step 2b.4); nothing about Google sign-in can be finished without it |
| Consent screen branding | none | The business name, support email, and optional logo her clients see on Google's permission screen (step 2b.4) |
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
      spam; if nothing arrives, step 2.4 SMTP is the usual culprit).

Sign-in (step 2b). Use a throwaway address you control plus one real Google
account.

- [ ] Make a profile with email and password. The confirmation email arrives,
      tapping it returns to the site signed in, and the profile shows the
      name typed at sign-up.
- [ ] Close the browser, reopen the site: still signed in, no code asked for.
      Come back the next day: still signed in.
- [ ] Sign out, sign back in with the password. No code.
- [ ] `select email, has_password, auth_provider from public.clients;` shows
      `true` / `password` for that account.
- [ ] Sign in with Google on a NEW address. One click, no code, and the
      client row shows `auth_provider = google`.
- [ ] Linking, the important one: take an address that already signed in with
      the 6-digit code and has a booking, then sign in with Google using that
      same address. It lands in the SAME account with the booking still
      listed, `auth_provider` flips to `google`, and there is only one row
      for that email in `public.clients`.
- [ ] Forgot password: request a reset, the 6-digit code arrives, set a new
      password, sign in with it. `has_password` stays `true`.
- [ ] A code-only client sets a password from her profile: `has_password`
      flips to `true` and the next sign-in takes the password.
- [ ] Wrong password gives one plain "check your email and password" message,
      and a made-up email gives the same one (no hint about who has an
      account).
- [ ] Google sign-in from the live domain, not just localhost. A
      `redirect_uri_mismatch` here means the authorized redirect URI in
      Google does not match the Supabase callback URL exactly (step 2b.4).
- [ ] Book a deposit service (for example Traditional Sew In, $50 deposit):
      no booking row is created yet. A row appears in `public.holds` with an
      `expires_at` about 15 minutes out, Stripe Checkout opens for exactly
      $50, and paying with 4242 creates the booking as `confirmed`, deletes
      the hold, sends the client her confirmation, and sends Ebony the
      new-booking alert. The dashboard shows it.
- [ ] Decline the card, or just close the Stripe tab: still no booking, and
      the slot is offered again as soon as the hold runs out. Nothing is
      emailed, because nothing was promised.
- [ ] Hold blocks the slot: with a hold live, load availability for that time
      in another browser. The slot is gone. When the hold expires it comes
      back.
- [ ] Book a no-deposit service (for example 2-Part Sew In): no payment step,
      status `request`, request email to the client AND the "needs your yes"
      alert to Ebony.
- [ ] Overlap guard: try booking a time overlapping an existing booking; the
      slot is gone, and forcing it returns the "just taken" error. (Even two
      simultaneous submissions cannot both land: `bookings_overlap`,
      `holds_overlap` and the `sp_slot_guard` trigger reject the second write
      and the API returns the same 409. A hold blocks a booking and a booking
      blocks a hold.)
- [ ] Expired hold that gets paid anyway: shorten `HOLD_MINUTES` to 1,
      start a checkout, wait it out, then pay. NO booking is created, and
      Ebony gets the "refund needed" alert naming the client. Restore
      `HOLD_MINUTES` afterwards.
- [ ] Cleanup job (step 6): after a hold expires, `public.holds` empties out
      within a few minutes even with nobody using the site.
- [ ] Sunday shows closed. On a Saturday, the last offered start time equals
      18:00 minus the service duration.
- [ ] Hours (step 3b): from the dashboard, close a day she normally works and
      save. That day disappears from the booking sheet AND from the hours
      table on the public site, and an appointment already booked on it is
      still there, listed back to her as affected. Put the day back and both
      return to normal.
- [ ] Hours with JavaScript turned off: the public hours table still reads
      correctly (it falls back to the static markup in `index.html`).
- [ ] Broadcast with a flyer: attach a picture, send, and the email shows the
      flyer above the message with a working full-size link. The file appears
      under Storage > flyers and the row in `public.broadcasts` has its
      `image_url`.
- [ ] Flyer limits: a file over 5 MB and a non-image file are both refused
      with one plain message, and NOBODY receives a message.
- [ ] Cancel from My bookings: status `canceled`, cancellation email arrives,
      and Ebony gets the client-cancellation alert saying the slot reopened.
- [ ] Pay a balance online from My bookings: the client gets the paid-in-full
      email and Ebony gets the "nothing to collect" alert.
- [ ] Owner alerts never reach a client: every row in `notifications_log`
      whose `event` starts with `owner_` (plus `payment_needs_refund` and
      `hold_expired_refund`) has HER address in `recipient`, never a
      client's.
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

### Google sign-in (Google Cloud)

Cleanest path is the same as Supabase: she creates the Google Cloud project
herself in step 2b.4, so it is hers from the start and nothing has to move.
If it was created under a developer's Google account instead, do not try to
recreate the credential quietly. Either add her as Owner (Google Cloud
console > IAM & Admin > IAM > Grant access, role Owner) and have the
developer step down to Editor, or build a fresh project in her account and
swap the new client ID and secret into Supabase. If you swap, add the same
authorized redirect URI first, because the moment the old credential is
deleted every Google sign-in fails.

The OAuth client secret lives in exactly two places: Google's console and
the Supabase Google provider field. It never goes in the repo, in
`js/config.js`, or in an email.

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
- [ ] Authentication > URL Configuration: Site URL is the live domain and the
      redirect allow-list still lists it with a `/**` ending (step 2b.3).
      Moving domains without this breaks confirmation links, password resets,
      and the return trip from Google all at once.
- [ ] Google sign-in still works from the live domain, and the authorized
      redirect URI in Google still matches the Supabase callback URL.
- [ ] One sign-up with a password and one Google sign-in, both landing in
      `public.clients` with the right `has_password` and `auth_provider`.
- [ ] Stripe webhook endpoint URL still points at the Supabase project URL
      and the live `whsec_` is set.
- [ ] `js/config.js` still points at the right project ref.
- [ ] The pg_cron hold cleanup job (step 6) still shows in `cron.job`.
- [ ] One end-to-end booking with the cheapest deposit service, refunded
      from her Stripe dashboard afterward.
- [ ] She has two-factor auth on GitHub, Supabase, Stripe, Cloudflare, and
      her email.
