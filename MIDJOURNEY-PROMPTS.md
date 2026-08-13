# Midjourney prompts — signature cards + hero imagery

Seven images: five for the "The five she's known for" cards, two for the hero
at the top of the page. Generate, then save each over its slot file (same
name, same place) and push; no code changes needed:

| Slot | File to overwrite | Shape |
|---|---|---|
| Wig Installs card | `assets/signature/wigs.jpg` | 4:5 |
| Knotless Braids card | `assets/signature/knotless.jpg` | 4:5 |
| Crochet card | `assets/signature/crochet.jpg` | 4:5 |
| Quickweaves card | `assets/signature/quickweave.jpg` | 4:5 |
| Sew-Ins card | `assets/signature/sewin.jpg` | 4:5 |
| Hero, big portrait | `assets/hero/main.jpg` | 4:5, shown uncropped |
| Hero, small polaroid | `assets/hero/back.jpg` | square 1:1 |

The slots currently hold stand-in photos, so nothing is broken while you work.
These images are ambiance for the category cards; her real client work stays in
the "Real clients, real results" gallery at the bottom and is labeled as hers,
so keep that separation.

## The look (locked)

The approved aesthetic is the glossy salon-campaign look: warm ivory backdrop
with rosewater tones, soft diffused beauty-dish light, champagne highlights,
luminous skin. Every prompt below keeps that language identical.

## The framing (this is what went wrong before)

The style was never the problem; the crop was. "Face in upper third",
"85mm", and "shallow depth of field" tell Midjourney to shoot a tight beauty
macro that slices the hairstyle off. So every prompt swaps those for one
framing block: **medium shot, camera pulled back, head and shoulders down to
the ribcage, the entire hairstyle from crown to ends inside the frame with
clear backdrop around it**, plus `--no extreme close-up, tight crop`.

And the site adds its own crop on top. Measured on the live page:

| Where | Card size | Shape |
|---|---|---|
| Desktop card, at rest | 225 x 432 | very tall and narrow |
| Desktop card, hovered | 387 x 432 | wide |
| Mobile card | 265 x 380 | tall |
| Hero portrait | ~460 x 575 | 4:5, shown uncropped |

The cards fill their box (`object-fit: cover`), so the at-rest desktop card
shows only the **middle ~65% of the image's width**. That is why the card
prompts also center the subject with clear backdrop on both sides: the sides
are the part the crop throws away.

**If a render comes out beautiful but too tight** (like the first hero take):
don't discard it. Upscale it in Midjourney and use **Zoom Out 2x** (or expand
the canvas in the Editor). It repaints the same photo outward — same face,
same light — revealing the rest of the hairstyle. Then crop to 4:5.

## Different women, different shades of brown

Each prompt names a different complexion (espresso, honey-brown, mahogany,
golden caramel, cocoa, chestnut) so the set reads like her real chair: seven
different women, not one model re-rendered. Keep those descriptors when you
tweak a prompt, and if two renders come back looking like the same woman,
re-roll one rather than shipping twins.

## Posing

No passport photos: every prompt gives its model a real hair-campaign pose
(fingers through the lengths, braids gathered over a shoulder, curls being
scrunched, a mid-flip, fingers lifting the roots). Poses mean hands, and hands
are where AI slips, so every prompt also carries `--no deformed hands, extra
fingers` — still, check fingers before shipping any render.

## Series consistency

Run all seven in one session. Once the first image comes out right, reuse it
as a style reference (`--sref <url of that image>`) on the rest so lighting
and grade match across the set.

## The card prompts

**1. Wig Installs — `wigs.jpg`**
```
editorial beauty portrait of a Black woman with deep espresso skin and a flawlessly melted lace frontal wig install, long jet-black body-wave hair with glossy sheen, hairline perfectly natural, one elegant manicured hand sliding through the lengths of her hair mid-motion, head tilted so the hair sweeps to one side, serene confident expression, warm ivory seamless studio backdrop, soft diffused beauty-dish lighting with champagne highlights, subtle rosewater pink tones in the background, high-end salon campaign photography, medium shot with the camera pulled back, head and shoulders down to the ribcage, the entire hairstyle visible from the crown to the very ends inside the frame, subject centered with clear backdrop space on the left and right of the hair, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 120 --no extreme close-up, tight crop, cropped hair, cut off hair, deformed hands, extra fingers, text, watermark
```

**2. Knotless Braids — `knotless.jpg`**
```
editorial beauty portrait of a Black woman with warm honey-brown skin and long medium knotless braids, clean precise parts, small gold cuffs catching light, both hands gently gathering the braids over one shoulder, glancing back over her shoulder at the camera, soft confident expression, warm ivory seamless studio backdrop, soft diffused beauty-dish lighting with champagne highlights, subtle rosewater pink tones in the background, high-end salon campaign photography, medium shot with the camera pulled back, head and shoulders down to the ribcage, the complete length of the braids visible from the scalp parts to the very ends inside the frame, subject centered with clear backdrop space on the left and right of the braids, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 120 --no extreme close-up, tight crop, cropped hair, cut off braids, deformed hands, extra fingers, text, watermark
```

**3. Crochet — `crochet.jpg`**
```
editorial beauty portrait of a Black woman with rich mahogany-brown skin and voluminous curly crochet braids, springy defined passion-twist curls framing her face, hands lifted scrunching the curls at both sides of her head, head tipped back mid-laugh, joyful relaxed expression, warm ivory seamless studio backdrop, soft diffused beauty-dish lighting with champagne highlights, subtle rosewater pink tones in the background, high-end salon campaign photography, medium shot with the camera pulled back, head and shoulders down to the ribcage, the whole shape of the style visible from crown to ends inside the frame, subject centered with clear backdrop space on the left and right so the curls never touch the edges, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 120 --no extreme close-up, tight crop, cropped hair, cut off curls, deformed hands, extra fingers, text, watermark
```

**4. Quickweaves — `quickweave.jpg`**
```
editorial beauty portrait of a Black woman with golden caramel skin and a sleek chin-length black bob quickweave, sharp side part, mirror-glossy finish, one hand tucking the bob behind her ear, opposite shoulder raised toward her chin, poised expression with eyes to camera, warm ivory seamless studio backdrop, soft diffused beauty-dish lighting with champagne highlights, subtle rosewater pink tones in the background, high-end salon campaign photography, medium shot with the camera pulled back, head and shoulders down to the ribcage, the entire bob shape visible inside the frame, subject centered with clear backdrop space on the left and right, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 120 --no extreme close-up, tight crop, cropped hair, cut off hair, deformed hands, extra fingers, text, watermark
```

**5. Sew-Ins — `sewin.jpg`**
```
editorial beauty portrait of a Black woman with smooth cocoa-brown skin and a long layered sew-in install, caught mid hair-flip with the loose glamorous curls in motion, one hand sweeping the hair over her shoulder, deep shine on every curl, warm confident gaze, warm ivory seamless studio backdrop, soft diffused beauty-dish lighting with champagne highlights, subtle rosewater pink tones in the background, high-end salon campaign photography, medium shot with the camera pulled back, head and shoulders down to the ribcage, the full length of the hair visible from the part down to the curled ends inside the frame, subject centered with clear backdrop space on the left and right, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 120 --no extreme close-up, tight crop, cropped hair, cut off hair, deformed hands, extra fingers, text, watermark
```

## The hero prompts

**6. Hero, big portrait — `hero/main.jpg`**

Renders at exactly 4:5, completely uncropped. Keep the hair's ends out of the
bottom-left corner: the box's bottom-left is clipped by a large rounded sweep.

```
editorial beauty portrait of a Black woman with deep chestnut-brown skin and a flawlessly installed long curly lace frontal, big bouncy defined curls with brilliant shine, one arm raised with fingers buried in the roots lifting the curls, elbow out in a classic hair-campaign pose, radiant expression, chin tilted slightly up, warm ivory seamless studio backdrop, soft diffused beauty-dish lighting with champagne highlights, subtle rosewater pink tones in the background, high-end salon campaign photography, medium shot with the camera pulled back, head and shoulders down to the ribcage, face in the upper half of the frame, the entire hairstyle visible from crown to the very ends inside the frame, curls kept clear of the bottom-left corner, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 120 --no extreme close-up, tight crop, cropped hair, cut off hair, deformed hands, extra fingers, text, watermark
```

**7. Hero, small polaroid — `hero/back.jpg`**

Sits over the big portrait like a small polaroid. It reads at thumbnail size,
so it wants one clear subject, but no close-up: a back three-quarter view
showing the whole braid pattern is the classic second shot of a hair campaign.

```
editorial beauty photograph of a Black woman with warm brown skin seen from behind at a three-quarter angle, long medium knotless braids with clean precise parts covering the whole back of her head and falling down her back, small gold cuffs catching warm light, rich deep shine on every braid, one hand sweeping a few braids over her shoulder, head turned slightly showing the edge of her profile, medium shot from head to mid-back, the full braid pattern visible inside the frame, warm ivory backdrop with blush rosewater tones, soft diffused beauty-dish lighting with champagne highlights, high-end salon campaign photography --ar 1:1 --style raw --s 120 --no extreme close-up, tight crop, macro, deformed hands, extra fingers, text, watermark
```

If the braids feel repetitive next to the knotless card, swap the subject
words for "silk-pressed hair" or "body-wave sew-in curls" and keep everything
else identical.

## Check them before you push

Open `tools/card-preview.html` in a browser and drop the images on their
slots. It shows each one inside the real rendered shapes (narrow desktop card,
hovered card, mobile, hero with its swept corner), so a bad crop is caught
before it goes live. If a style loses its ends or sides, Zoom Out in
Midjourney or regenerate with more space around the subject.

## After generating

1. Export each as JPG, longest edge about 1600px (nothing renders larger).
2. Overwrite the five files in `assets/signature/` and the two in `assets/hero/`.
3. `git add assets && git commit -m "Final imagery" && git push`
4. Hard-refresh the live site; the GitHub Pages edge cache can take ~10 minutes.
