# Midjourney prompts — signature section imagery

Five images, one per card in the "The five she's known for" section. Generate,
then save each over its slot file (same name, same place) and push; no code
changes needed:

| Card | File to overwrite |
|---|---|
| Wig Installs | `assets/signature/wigs.jpg` |
| Knotless Braids | `assets/signature/knotless.jpg` |
| Crochet | `assets/signature/crochet.jpg` |
| Quickweaves | `assets/signature/quickweave.jpg` |
| Sew-Ins | `assets/signature/sewin.jpg` |

The slots currently hold her real StyleSeat photos, so nothing is broken while
you work. These generated images are ambiance for the category cards; her real
client work stays in the "Real clients, real results" gallery at the bottom and
is labeled as hers, so keep that separation.

## How the cards crop
Tall cards, faces kept near the top (`object-position: center 22%`). Generate
at `--ar 4:5` and keep the subject's face in the upper third with breathing
room above the hairline; the bottom third gets a dark gradient with white text
over it, so avoid bright detail at the very bottom.

## Series consistency
Run all five in one session. After the first image comes out right, reuse it as
a style reference (`--sref <url of the first image>`) on the other four so
lighting and grade match across the row. Keep stylize low so the palette
directions hold.

Palette to hit (matches the site): warm ivory backdrop, rosewater and blush
tones, soft champagne highlights; skin rich and true, never gray or washed out.

## The prompts

**1. Wig Installs — `wigs.jpg`**
```
editorial beauty portrait of a dark-skinned Black woman with a flawlessly melted lace frontal wig install, long jet-black body-wave hair with glossy sheen, hairline perfectly natural, chin tilted slightly up, serene confident expression, warm ivory seamless studio backdrop, soft diffused beauty-dish lighting with champagne highlights, subtle rosewater pink tones in the background, shot on 85mm, shallow depth of field, high-end salon campaign photography, face in upper third of frame --ar 4:5 --style raw --s 120
```

**2. Knotless Braids — `knotless.jpg`**
```
editorial beauty portrait of a dark-skinned Black woman with long medium knotless braids falling past her shoulders, clean precise parts, a few braids pulled forward, gold cuffs catching light, soft smile looking over her shoulder, warm ivory studio backdrop with a blush pink gradient, soft window-style diffused light, glowing moisturized skin, shot on 85mm f2, luxury haircare campaign photography, face in upper third of frame --ar 4:5 --style raw --s 120
```

**3. Crochet — `crochet.jpg`**
```
editorial beauty portrait of a dark-skinned Black woman with voluminous curly crochet braids, springy defined passion-twist curls framing her face, joyful relaxed expression mid-laugh, warm ivory seamless backdrop with soft rosewater pink wash, airy diffused studio light with champagne rim light on the curls, shot on 85mm, shallow depth of field, high-end beauty editorial photography, face in upper third of frame --ar 4:5 --style raw --s 120
```

**4. Quickweaves — `quickweave.jpg`**
```
editorial beauty portrait of a dark-skinned Black woman with a sleek chin-length black bob quickweave, sharp side part, mirror-glossy finish, dramatic clean silhouette, poised expression with eyes to camera, warm ivory studio backdrop with a soft blush gradient, precise soft beauty lighting with gentle champagne kicker, shot on 85mm, luxury salon campaign photography, face in upper third of frame --ar 4:5 --style raw --s 120
```

**5. Sew-Ins — `sewin.jpg`**
```
editorial beauty portrait of a dark-skinned Black woman with a long layered sew-in install, loose glamorous curls with deep shine cascading over one shoulder, hand gently lifting the curls, warm confident gaze, warm ivory seamless backdrop with rosewater pink tones, soft wraparound diffused light, glowing skin with champagne highlights, shot on 85mm f2, high-end beauty editorial photography, face in upper third of frame --ar 4:5 --style raw --s 120
```

## After generating
1. Export each as JPG, longest edge ~1600px (the cards never render larger).
2. Overwrite the five files in `assets/signature/`.
3. `git add assets/signature && git commit -m "Signature card imagery" && git push`
4. Hard-refresh the live site; GitHub Pages edge cache can take ~10 minutes.
