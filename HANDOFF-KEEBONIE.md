# Sitting Pretty — what Ke'Ebonie needs to do (plain-English version)

Everything below is set up so the site, the money, and the client list belong to
**her**, not to Taylormade Creative. Nelson stays on as the person who maintains it.

## What she gets

- Her own booking site: clients pick the style, the day, and the time, pay the
  deposit, and get a confirmation. No StyleSeat, no marketplace, no one else's
  branding, nobody taking a cut of her deposits.
- A dashboard on her phone: every booking, confirm or cancel, block days she is
  out, see her whole client list, and send one message to every client at once
  (sick day, holiday hours, a promo).
- Automatic messages: booking confirmations, cancellations, and deposit reminders.

## How the money works

The deposit is what holds the time. The moment it clears, that slot is gone from
the site and nobody else can take it. No deposit, no hold: unpaid appointments
are cancelled automatically after 24 hours, which is her existing rule, now
enforced by the site instead of by her chasing people.

The rest of the price is hers to collect however she likes:

- **In the chair**, the way she does it now. This is the default and nothing on
  the site pushes clients away from it.
- **Online, before they come.** A client can sign in any time and tap "Pay
  balance." It is offered, never required.
- **She marks it paid herself.** When she takes cash, Zelle, or a card in
  person, one tap on her dashboard records it and the booking shows paid in full.

Her services priced with a plus, like "Add hair to braids, $50+", never get
charged a fixed amount online, because the real number depends on the hair. The
site says she settles those in person, and when she records the payment it asks
what she actually collected.

## How clients sign in

Three ways, so nobody gets stuck:

- **Continue with Google.** One tap, nothing to remember. Most of her clients
  already have a Google account on their phone.
- **Email and password.** They make a profile once and log in normally after that.
- **Emailed code.** The backup, and how anyone resets a forgotten password.

Once someone signs in, they stay signed in on that phone, so booking again later
is just: pick the style, pick the time, done.

## The four accounts (about 30 minutes, all in her name)

| # | Account | Why | Cost |
|---|---------|-----|------|
| 1 | **Stripe** | Takes deposits and payments, pays out to her bank | 2.9% + 30 cents per payment, no monthly fee |
| 2 | **Supabase** | Holds bookings and client accounts | Free tier is plenty to start |
| 3 | **GitHub** | Hosts the website itself | Free |
| 4 | **Domain name** | e.g. sittingprettyfw.com | About 10 to 15 dollars a year |

She creates each one with her own email and password. For Stripe she will need
her bank account and routing numbers and a photo ID; that is Stripe verifying
her identity, and it is the reason payouts land in her account automatically.
Nelson never needs her banking details, and her deposits never pass through his
accounts.

## What Nelson needs from her

1. **Her real email address** for the business (the one clients would recognize).
   The site currently uses a placeholder.
2. **The domain she wants.** A few options to check availability on.
3. **Is she a licensed cosmetologist?** The word "licensed" is off the site until
   she confirms, because that is a credential claim.
4. **Her Instagram handle**, to link from the site.
5. **Yes or no on text messages.** Email confirmations are free and ready. Adding
   real SMS costs about $1.15 a month for a phone number plus roughly a penny per
   text. Her clients are phone people, so this is probably worth it.

## What she should look at first

The site is running locally on Nelson's machine right now: the full booking flow
(pick a style, pick a day and time, sign in, pay the deposit) and her dashboard.
Payments are simulated until her Stripe account is connected, so she can click
all the way through without any real money moving.

Things to check while she looks:
- Do the prices and deposits match what she actually charges today?
- Is she happy with clients having the option to pay the rest online, or would
  she rather every balance be settled in the chair?
- Are the five house rules on the site still how she runs her chair?
- Are those the photos she wants leading her site, and are all of them her work?
- Does anything on the booking flow feel confusing compared to StyleSeat?

## One thing to decide before launch

Right now anyone can make an account with any email and request an appointment.
For the services where she has not published a deposit, that request holds a
real time slot until she confirms it. At her volume that is almost certainly
fine, and it keeps booking easy. If it ever becomes a problem the site can
require a confirmed email address, or limit how many pending requests one person
can have at a time. Her call, and it is easy to change later.
