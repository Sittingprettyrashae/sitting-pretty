# While you're in her chair

Braids run hours. That is more than enough time to get her live. Work down this
list on your laptop; she only has to touch the parts marked **HER**.

## 0. Email: settled

Two sources disagree and everything else keys off this:

- Her text to you said `her Gmail address (kept out of this repo)` (four t's)
- Her StyleSeat address decodes to `sher Gmail address (kept out of this repo)` (two t's)

**Do not type it in from either one.** Have her send you an email from her phone
right there, or open Gmail and read it off her account. Every booking alert,
her admin login, and her Stripe payouts hang on this being exact. One wrong
letter and she never hears about a single booking.

Once you have it, tell me and I will put it everywhere it belongs in one pass.

## 1. HER accounts (about 30 minutes, she drives)

She signs up, with the address above. Her name, her email, her password, her money.

1. **Stripe** — account already made (keeboniehill@gmail.com). It is NOT
   activated yet: `charges_enabled` and `payouts_enabled` are both false and
   she has not submitted details. Finish it in her dashboard: bank account and
   routing numbers, plus a photo ID. That is Stripe verifying her identity, and
   it is why payouts land in her account and why you never touch her banking
   details. Also set the business name: it currently reads "Sitting Pretty
   Rashae's sandbox", and clients see that on the payment page.
   **Rotate the secret key** while you are in there. It was sent in plaintext,
   so treat it as burned: Developers > API keys > roll it, then tell me the new
   one and I will swap it in.
2. **Supabase** — she is signed in (keeboniehill@gmail.com). Create a project
   in HER account, any region near Texas, and save the database password it
   shows you once. Then, still as her: account settings > Access Tokens >
   generate one, and send it to me.

   Careful: the Supabase CLI on your laptop is logged in as YOU (it lists
   taylormade-studio, rosies-beauty-spa, runitup-dallas). Deploying from there
   as-is would put her platform in your org. Do not `supabase login` to fix it,
   that wipes your session for your other clients. Her access token in one
   shell handles it.
3. **Google Cloud** console.cloud.google.com — free. This is only so "Continue
   with Google" works on her booking page.

Have her use the same email everywhere, and get her to save the passwords
somewhere she will still have them in a year.

## 2. Wiring (you, ~20 minutes)

`RUNBOOK.md` has the exact commands and the precise redirect URI to paste,
which is the step people get wrong. Order: run `schema.sql`, deploy the edge
functions, set the secrets, point the Stripe webhook, add her domain to the
Supabase allow-list, then flip `js/config.js` from the demo to her project.

## 3. Ask her while she works

- Is she a **licensed cosmetologist**? The word is off her site until she says
  yes, because it is a credential claim.
- Her **Instagram handle**, to link from the site.
- **Texting yes or no.** Until it is on, everything is email only, including
  her own booking alerts. About $1.15/month plus a penny a message.
- Does she want clients to be able to **pay the balance online**, or should
  every balance be settled in her chair? Right now both work and nothing
  pushes them either way.
- **Photos.** The ones on the site came off StyleSeat and are only 540px, which
  is soft on a modern phone. Ask her to AirDrop the originals of her favorites.
- Anyone booking a service with no set deposit holds a real slot until she
  confirms. Fine at her volume. Tell her it can be tightened later if it ever
  gets abused.

## 4. Domain (no rush)

She does not need one today. The site works right now at
`taylormadecreative.github.io/sitting-pretty`. When she picks one, it is about
$12 a year through Cloudflare, and changing to it takes me a few minutes: the
link-preview URLs, the Supabase redirect allow-list, and the Google redirect
URI all point at the address, so they get updated together.

If she wants to choose one while you are there, check availability for
something short she can say out loud in a DM.

## 4b. Real Stripe checkout already works

Test mode is live on the demo, so the deposit step goes to a genuine Stripe
page with her business name on it, Apple Pay and Cash App included. Pay with
the test card **4242 4242 4242 4242**, any future expiry, any CVC, any ZIP.
No real money moves until her account is activated and the live keys go in.

## 5. Show her the thing

Pull up the site on your phone and let her book an appointment with herself.
Style, day, time, sign in, deposit. Then open her dashboard and show her the
booking land, the Hours tab, and Message everyone with a flyer attached.

What to watch for: does anything confuse her compared to StyleSeat, and are the
prices and deposits still what she actually charges today.
