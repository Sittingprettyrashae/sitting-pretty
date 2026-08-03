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
(pick a style, pick a day and time, log in with an emailed code, pay the deposit)
and her dashboard. Deposits are simulated until her Stripe account is connected,
so she can click all the way through without any real money moving.

Things to check while she looks:
- Do the prices and deposits match what she actually charges today?
- Are the five house rules on the site still how she runs her chair?
- Are those the photos she wants leading her site, and are all of them her work?
- Does anything on the booking flow feel confusing compared to StyleSeat?
