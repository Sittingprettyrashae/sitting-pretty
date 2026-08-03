# DESIGN.md — Sitting Pretty

## Scene sentence
A client on her couch at 10pm, phone in hand, dark room, deciding whether to book a frontal install for Saturday. Dark, warm, luxe surface so the photos glow like an IG feed; big tap targets; prices readable at arm's length.

## Theme
Dark espresso-cocoa, warm not gray. Committed color strategy: warm copper/caramel carries CTAs, prices, and accents (30-40% presence). No pink reflex, no black/gold barbershop reflex.

## Palette (OKLCH)
- bg: oklch(16% 0.015 55) deep espresso brown
- bg-raised: oklch(21% 0.02 55)
- ink: oklch(94% 0.012 75) warm cream
- ink-dim: oklch(72% 0.02 70)
- accent: oklch(72% 0.14 55) copper/caramel
- accent-deep: oklch(58% 0.13 45)
- blush: oklch(80% 0.06 30) soft warm secondary (sparingly)

## Typography
- Display + body: Satoshi (Fontshare). Weights 500/700/900.
- Script accent for "Sitting Pretty" wordmark moments: Playball or similar single script, used only for the brand word.
- Hero H1 clamp(2.6rem, 7vw, 5.5rem), max 2-3 lines, wide container.
- Body max 70ch, scale ratio >= 1.28.

## Motion
- GSAP + ScrollTrigger via CDN. Intro hero reveal on load; pinned services intro; scale-and-fade gallery images; infinite category marquee.
- All easings ease-out (cubic-bezier(0.23,1,0.32,1)); UI transitions <= 250ms; scroll scrubs slow.
- prefers-reduced-motion: kill transforms, keep fades.

## Components
- Floating pill nav (glass, minimal: Work, Services, About, Book).
- Editorial split hero: text left, portrait/photo right, massive negative space.
- Inline pill photos inside the big headline.
- Services: category accordion (horizontal expand on desktop where sane, vertical on mobile), every service with price, duration, deposit.
- Booking: sms:// and tel:// links, service name pre-filled in SMS body.
