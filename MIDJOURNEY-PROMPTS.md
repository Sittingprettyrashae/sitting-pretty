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

## How the cards crop (measured on the live site)

| Where | Card size | Shape |
|---|---|---|
| Desktop, at rest | 225 x 432 | very tall and narrow |
| Desktop, hovered | 387 x 432 | wide |
| Mobile | 265 x 380 | tall |

The card fills its box (`object-fit: cover`), so a 4:5 image shows only its
**middle ~65% of width** in the at-rest desktop card, and the sides are thrown
away. Hovering reveals the rest. That is why every prompt below asks for the
whole hairstyle to sit in the **center of the frame with wide empty margins on
the left and right**: those margins are the part that gets cropped, so the
style itself survives at every size.

Two rules that matter more than any adjective:

1. **The entire hairstyle must be inside the frame**, crown to the very ends,
   not touching any edge. Midjourney loves to run long braids off the bottom.
2. **Keep the style inside the middle column**, with plain backdrop either
   side, and leave clear space below the ends of the hair.

Generate at `--ar 4:5`. Do not switch to a taller ratio: it saves the sides but
starts cutting the bottom of the hair on hover, which is worse.

## Making them look real, not AI

The fastest tells of an AI image are porcelain-smooth skin, identical cloned
curls, dead-center symmetry, and soft shadowless "campaign" light. Every
prompt below fights those four directly: film stock and grain, visible pores
and flyaways, varied imperfect texture, directional light with real shadows,
and poses that are not a straight-to-camera catalog smile. If a render still
feels synthetic, drop stylize further (`--s 50`) before changing the words.

## Series consistency

Run all five in one session. Once the first image comes out right, reuse it as
a style reference (`--sref <url of that image>`) on the other four so lighting
and grade match across the row. Keep stylize low so the palette holds.

Palette to hit (matches the site): warm ivory backdrop, rosewater and blush
tones, soft champagne highlights; skin rich and true, never gray or washed out.

## The prompts

**1. Wig Installs — `wigs.jpg`**
```
editorial fashion magazine portrait of a dark-skinned Black woman with a melted lace frontal wig install, long jet-black body-wave hair, natural varied wave pattern with a few flyaway strands, the entire length of the hair visible from crown to ends well inside the frame, calm direct gaze with a hint of attitude, chin slightly angled, head and shoulders to mid-torso, subject centered with generous empty space on the left and right, warm ivory backdrop with rosewater tones, hard directional window light with soft falling shadows, real skin texture with visible pores and natural sheen, shot on medium format film, Kodak Portra 400, subtle grain, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 50 --no cropped hair, cut off hair, airbrushed skin, plastic skin, text, watermark
```

**2. Knotless Braids — `knotless.jpg`**
```
editorial fashion magazine portrait of a dark-skinned Black woman with long medium knotless braids, the complete length of the braids visible from the scalp parts all the way to the ends inside the frame, braids falling close to the body with natural slight unevenness, a few baby hairs at the hairline, small gold cuffs, quiet self-assured expression looking just past the camera, head and shoulders to mid-torso, subject centered with generous empty space on the left and right, warm ivory backdrop with a blush wash, directional daylight through a window with true shadows, real skin texture with visible pores, shot on medium format film, Kodak Portra 400, subtle grain, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 50 --no cropped hair, cut off braids, airbrushed skin, plastic skin, text, watermark
```

**3. Crochet — `crochet.jpg`**
```
editorial fashion magazine portrait of a dark-skinned Black woman with voluminous curly crochet braids, the whole shape of the style visible from crown to ends inside the frame, springy passion-twist curls with naturally varied definition, some tight and some loosening, a few frizzy strands catching the light, caught mid-laugh looking away from camera, head and shoulders to mid-torso, subject centered with generous empty space on the left and right so the curls never touch the edges, warm ivory backdrop with a rosewater wash, hard rim light from one side with soft fill, real skin texture with visible pores and natural sheen, shot on medium format film, Kodak Portra 800, subtle grain, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 50 --no cropped hair, cut off curls, airbrushed skin, plastic skin, identical curls, text, watermark
```

**4. Quickweaves — `quickweave.jpg`**
```
editorial fashion magazine portrait of a dark-skinned Black woman with a sleek chin-length black bob quickweave, the entire bob shape visible inside the frame, sharp side part, glossy finish with individual hair strands visible, strong poised expression, chin tilted, direct on-camera flash with a crisp shadow behind her on the wall, nineties fashion editorial energy, head and shoulders to mid-torso, subject centered with generous empty space on the left and right, warm ivory backdrop with a blush cast, real skin texture with visible pores and natural highlights, shot on film, subtle grain, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 50 --no cropped hair, cut off hair, airbrushed skin, plastic skin, text, watermark
```

**5. Sew-Ins — `sewin.jpg`**
```
editorial fashion magazine portrait of a dark-skinned Black woman with a long layered sew-in install, the full length of the hair visible from the part down to the curled ends inside the frame, loose lived-in curls with varied direction and a few strands out of place, hair caught in slight motion as she turns toward the camera, warm knowing gaze, head and shoulders to mid-torso, subject centered with generous empty space on the left and right, warm ivory backdrop with rosewater tones, directional golden-hour window light with real falling shadows, real skin texture with visible pores and natural sheen, shot on medium format film, Kodak Portra 400, subtle grain, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 50 --no cropped hair, cut off hair, airbrushed skin, plastic skin, text, watermark
```

## The hero prompts

The hero is the first thing anyone sees, so these two carry the whole page.
Same series, same palette; run them in the same session with the same `--sref`
as the cards so top and middle of the page feel like one shoot.

**6. Hero, big portrait — `hero/main.jpg`**

This slot renders at exactly 4:5, completely uncropped, so the whole frame
shows. The one catch: the bottom-left corner of the box is clipped by a large
rounded sweep, so keep the hair's ends and anything important out of that
corner. Face belongs in the upper half.

```
raw editorial fashion magazine cover portrait of a dark-skinned Black woman with a long curly lace frontal install, big lived-in curls with naturally varied definition, individual strands and baby hairs visible, some curls tighter than others, the entire hairstyle inside the frame from crown to ends, unguarded expression with quiet confidence, lips parted slightly, looking just off camera, head and shoulders to mid-torso, subject centered, face in the upper half of the frame, curls kept clear of the bottom-left corner, warm ivory backdrop with a rosewater gradient, hard directional window light raking across her face casting true soft shadows, real skin texture with visible pores, fine facial hair and natural oil sheen, unretouched beauty, shot on medium format film, Kodak Portra 800, visible grain, in the style of a printed magazine editorial, complete hairstyle in frame, nothing cropped at the edges --ar 4:5 --style raw --s 50 --no cropped hair, cut off hair, airbrushed skin, plastic skin, smooth skin, identical curls, symmetrical pose, text, watermark
```

If it still reads synthetic, add `--sw 200` with an `--sref` of a real magazine
beauty photo you like, or push the film language harder ("scanned film
negative, halation").


**7. Hero, small polaroid — `hero/back.jpg`**

A small square that sits over the big portrait's corner like a polaroid,
rotated a few degrees. It reads at thumbnail size, so it wants one bold
texture, not a full scene: a tight detail crop of finished hair.

```
extreme close-up editorial photograph of knotless braids on a dark-skinned Black woman, tight crop filling the square frame with braid texture, individual strands and slight frizz visible at the parts, small gold cuffs catching warm directional light, deep natural sheen, warm ivory and blush tones in the soft-focus background, shot on medium format film with visible grain, printed magazine detail page --ar 1:1 --style raw --s 50 --no airbrushed, plastic, text, watermark, face
```

If the braids detail feels repetitive next to the knotless card, swap the
subject words for "silk-pressed curls" or "body-wave sew-in curls" and keep
everything else identical.

## Check them before you push

Open `tools/card-preview.html` in a browser and drop the five images on it. It
shows each one inside the real card shape at all three sizes (desktop at rest,
desktop hovered, mobile), so you can see exactly what gets cropped before it
goes live. If a style loses its ends or its sides, regenerate that one with
more space around the subject rather than accepting it.

## After generating

1. Export each as JPG, longest edge about 1600px (the cards never render larger).
2. Overwrite the five files in `assets/signature/`.
3. `git add assets/signature && git commit -m "Signature card imagery" && git push`
4. Hard-refresh the live site; the GitHub Pages edge cache can take ~10 minutes.
