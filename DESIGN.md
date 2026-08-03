# DESIGN.md — Sitting Pretty (v2, client-directed feminine light)

## Client direction (2026-08-02, overrides v1)
Ke'Ebonie (via Nelson): v1's dark espresso/copper "doesn't give feminine," and the
site must feel easy and familiar to clients coming from StyleSeat. So: light,
soft, glam; layout patterns her clients already know (service list with prices
and Book buttons, photo grid, rating up top, simple date/time picker).

## Scene sentence
A client on her phone at night, tapping through from Instagram: soft warm light
page that feels like a beauty brand, photos glowing like an IG feed, prices
readable instantly, booking in four familiar taps.

## Theme
Warm ivory surfaces, deep plum-cocoa ink, dusty raspberry-rose as the committed
accent (CTAs, prices, selected states), champagne for stars/small warmth.
Elevated rosewater, NOT bubblegum: chroma stays restrained, plum keeps it adult.
Tokens live in `css/tokens.css` — both pages consume them.

## Typography
- Display + body: Satoshi (Fontshare) 500/700/900.
- Script accent: Playball, for the wordmark and section eyebrows only.
- Hero H1 2–3 lines max, wide container. Body ≤70ch, scale ratio ≥1.28.

## Layout (StyleSeat-familiar)
- Sticky light pill nav: wordmark, Prices, My bookings, Book Now.
- Hero: warm, photo-forward, rating line, primary CTA.
- Services: category accordion, each row = name + duration/deposit meta,
  price right-aligned, rose Book button. (StyleSeat's exact mental model.)
- Booking sheet (bottom sheet on mobile, modal on desktop): service summary →
  date strip (next 14 days) → time chips → email code login → deposit checkout
  → confirmed screen. Progress dots, one step visible at a time.
- Gallery grid, about, policies, hours: keep v1 content, restyled light.

## Motion
GSAP scroll reveals stay but gentler (smaller y, faster). Sheet transitions
follow Emil rules: 200-250ms, ease-out, translateY(100%) in/out, scale .97 on
press. prefers-reduced-motion: fades only.

## Don'ts
- No dark theme anywhere in client-facing pages.
- No neon/bubblegum pink; rose stays dusty, ink stays plum.
- Never text over faces. Real client photos only.
