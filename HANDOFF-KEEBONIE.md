# Sitting Pretty — what Ke'Ebonie needs to do (plain-English version)

Everything below is set up so the site, the money, and the client list belong to
**her**, not to Taylormade Creative. Nelson stays on as the person who maintains it.

## What she gets

- Her own booking site: clients pick the style, the day, and the time, pay the
  deposit, and get a confirmation. No StyleSeat, no marketplace, no one else's
  branding, nobody taking a cut of her deposits.
- A dashboard on her phone with everything she needs to run the chair:
  - **Bookings.** Confirm, cancel, mark someone paid in person, see what is
    still owed on each one.
  - **Her hours.** She sets her own days and times whenever she likes, and the
    booking calendar and the hours on her website follow immediately. Changing
    her hours never cancels an appointment already on the books; it shows her
    which ones now sit outside her new hours and lets her decide.
  - **Calendar.** Block a day she is taking off so nobody can book it.
  - **Clients.** Her whole list, searchable, with phone numbers.
  - **Message everyone.** One message to every client for a sick day, holiday
    hours, or a promo, and she can **attach a flyer** straight from her phone
    for anything she is marketing.
- She hears about every booking. A new paid booking, a request waiting on her
  yes, a cancellation, a balance paid online, and an appointment dropped for an
  unpaid deposit all reach her with the client's name and number, so she never
  has to go looking in the dashboard to find out something happened.
- Her clients get automatic messages too: confirmations, cancellations, and
  receipts when they pay.

## How the money works

The deposit is what books the spot, exactly the way she asked for it. No money,
no appointment: nothing goes on her calendar until the deposit clears. While a
client is paying, that time is held for fifteen minutes so nobody can take it
out from under her, and if she walks away from checkout the slot is free again
within minutes.

That is stricter than her old StyleSeat rule, where someone could book and then
have a day to pay. Nobody can tie up a Saturday without paying for it now.

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
5. **Yes or no on text messages.** Everything is written and ready to text, but
   until a number is set up it all goes out by email only. That includes the
   alerts about her own bookings. Adding real texting costs about $1.15 a month
   for the number plus roughly a penny per message. Her clients are phone
   people and so is she, so this is probably worth it.

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
