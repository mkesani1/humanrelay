# Asset Briefs — Relay Demo Frames (humanrelay.com)

Briefs for photorealistic images (and two optional video loops) to replace the placeholder
SVG illustrations in the rotating Relay demo (`public/index.html`, Judge section).
Each image plays the role of **the frame a machine sent with its question** — it must
look like sensor/user-generated imagery, not marketing photography and not AI gloss.

## Global spec (applies to every asset)

- **Final crop:** 2.91:1 (the site slot). Generate the widest aspect available
  (21:9 ideal, 16:9 fine) at ≥2048px wide, composed so a **center horizontal band**
  survives a 2.91:1 crop — keep all story-critical content in the middle ~70% of
  frame height. I do the final crop + compression.
- **Chip clearance:** the site overlays a small "ATTACHED FRAME" chip in the top-left.
  Keep the top-left ~15% × 20% of the final crop low-detail (sky, wall, blur).
- **No text, no watermarks, no logos, no HUD/overlays baked in.** Reticles, chips,
  and labels are added by the site so they stay crisp and editable.
- **No identifiable people, no faces, no readable license plates.** These render at
  ~520px wide; distant unidentifiable figures are acceptable only where noted.
- **Grade:** one consistent grade across the set — muted, slightly desaturated,
  neutral-to-cool, natural grain. These sit on a near-black warm card (#201E1A).
  Avoid HDR glow, oversharpening, and the saturated "AI hero shot" look. Each frame
  may keep its native camera character (phone vs dashcam vs drone) — grade unifies them.
- **Realism over beauty:** slightly imperfect framing, plausible noise/motion blur.
  A too-perfect image reads as stock and kills the premise.
- **Ambiguity calibration (the most important instruction):** every image must make
  the stated model confidence believable. A field guide photo fails the brief. The
  human's verdict must be *checkable* in the image, but only with attention.
- **Delivery:** highest-quality PNG or JPEG, no upscaler artifacts. I'll convert to
  WebP/AVIF (~60–90 KB each), lazy-load all but the active frame.
- Filenames: `public/frames/{bee,flood,bag,cones,eagle}.{png|jpg}` + optional
  `{flood,cones}.webm`.

---

## 1. `bee.png` — "What's nesting in the wall — bees or wasps? Model says 60% wasps."

**Role:** photo a homeowner texted to a pest-control company. The human's verdict:
*bees (fuzzy bodies, wax comb) → send a beekeeper, not an exterminator.*

**Prompt seed:**
> Smartphone photo taken indoors of a partially opened wall cavity between wooden
> studs, exposed honeycomb — irregular waxy comb in muted amber — with several
> honeybees crawling on it. Shot slightly too close with phone flash, mild motion
> blur on one bee, slightly off-center amateur framing, drywall dust at the opening
> edges. Dim utility-room lighting. Realistic phone-camera noise. No people, no
> text, no logos.

**The tells (must be verifiable on close look):** fuzzy/hairy insect bodies; comb is
waxy hexagonal cells, not gray papery layers. **Ambiguity:** insects partly blurred
or in shadow so a 60%-wasp model call is plausible — a couple of bees can read
wasp-ish at a glance. **Avoid:** textbook macro sharpness, swarms (reads as horror,
we want service-call), wasp nests in frame.

## 2. `flood.png` — "Is this safe to drive through?" (delivery robot)

**Role:** forward camera frame from a low delivery robot / AV on a residential street
after heavy rain. Verdict: *no — water spans the full width, vehicles ahead turning back.*

**Prompt seed:**
> Dashcam-style wide-angle frame from low vehicle height: a suburban two-lane road
> ahead fully covered by murky floodwater spanning curb to curb, light rain still
> falling, overcast sky, wet reflections. In the middle distance one car is
> mid-three-point-turn coming back from the water's edge, brake lights on. Subtle
> wide-angle distortion at frame edges, faint droplets on the lens, dashcam-grade
> sharpness and noise. No readable plates, no people outside cars, no text.

**The tells:** water clearly spans the full road width; the turning car (social
evidence). **Ambiguity:** water depth must be genuinely unreadable — flat gray sheet,
no helpful depth markers. **Avoid:** dramatic disaster flooding, submerged cars,
sunshine. This is "20 centimeters or 2 meters? — can't tell," not a catastrophe.

## 3. `bag.png` — "Is this $1,400 handbag authentic? Model confidence: 58%."

**Role:** seller's listing photo on a resale marketplace. Verdict: *reject — date-code
format wrong for claimed year.* (The site adds the authentication-zoom UI; the photo
just needs to be a believable listing.)

**Prompt seed:**
> Amateur marketplace listing photo: a structured tan-brown leather handbag with a
> top handle, photographed at home on a light bedsheet or wooden table near a window,
> soft uneven daylight, slight phone perspective skew. Visible interior fabric tag
> partially flipped open showing an embossed (unreadable) stamp area. Completely
> generic design — NO recognizable brand, monogram pattern, or logo hardware of any
> existing fashion house. Honest used condition: faint handle wear, one soft crease.
> No text, no people, no watermark.

**The tells:** a stamp/date-tag area exists to inspect (embossing visible, content
not legible). **Ambiguity:** the bag should look convincing — the photo alone can't
settle authenticity; that's the point. **Avoid — legal hard line:** anything
resembling LV/Chanel/Hermès/Gucci etc.; invented neutral design only. Avoid studio
product photography (it's a home listing).

## 4. `cones.png` — "Cones contradict the lane markings. Which do I follow?" (robotaxi)

**Role:** roof-camera frame from an AV approaching overnight roadworks. Verdict:
*follow the cones — the painted lane runs into fresh concrete.*

**Prompt seed:**
> Autonomous-vehicle roof camera frame, eye-level wide shot of an urban road in
> early morning flat light: existing white dashed lane markings continue straight
> ahead directly into a rectangular patch of fresh, darker wet concrete in the
> roadway, while a line of orange traffic cones cuts diagonally across the lanes
> directing traffic to the left around the patch. No workers present, work zone
> looks freshly set up, maybe one barrier board. Slight sensor-camera flatness and
> noise, neutral grade. No people, no readable signs or text, no vehicles close by.

**The tells:** the painted line literally enters the wet patch; the cone path is
coherent and continuous. **Ambiguity:** both "signals" must look equally official —
crisp paint vs. orderly cones; nothing screams which is current except the wet
concrete a careful look catches. **Avoid:** chaos, traffic jams, text on signage
(generation models garble it), workers (adds people problems).

## 5. `eagle.png` — "Common buzzard or protected golden eagle?" (survey drone)

**Role:** still from a wind-farm compliance drone. Verdict: *juvenile golden eagle —
log sighting, hold work.* (The site overlays the targeting reticle; do not bake one in.)

**Prompt seed:**
> Aerial drone photograph over open upland terrain, soft overcast light: one wind
> turbine at the left edge of frame, and in the middle distance a single large
> raptor in soaring flight, wings spread, seen from slightly above — small in frame
> (5–8% of frame width), slight motion softness, dark plumage with subtly lighter
> patches near the wing bases and pale tail base. Muted greens and grays of moorland
> below, hazy horizon. Realistic drone-camera sharpness falloff at distance. No
> text, no people, no vehicles, no overlays.

**The tells:** bird big-winged and dark (eagle-plausible), faint white wing patches /
pale tail base (juvenile golden eagle markers) *suggested*, not crisp. **Ambiguity:**
the bird must be far enough that a classifier punting is believable — an expert reads
silhouette + patch pattern; a layperson sees "big bird." **Avoid:** majestic close-up
eagle portraits (kills the premise entirely), multiple birds, bird too near the
turbine blades (implies a strike story we don't want).

## 6. `crop.png` — "Aphids on this soybean — schedule tonight's spray pass?" (crop-scouting agent)

**Role:** field photo from a scout's phone, sent by an agronomy agent. Verdict:
*hold the spray — ladybird larvae are eating the colony; spraying kills the
beneficials and wastes the pass.*

**Prompt seed:**
> Close-up smartphone photo taken in a commercial soybean field: the underside of a
> green soybean leaf, with a cluster of small pale-green aphids along the leaf
> veins — and among them, one or two dark, elongated, alligator-shaped larvae with
> faint orange markings, slightly out of focus. A gloved fingertip steadying the
> leaf at the frame edge is fine (no skin, no branding). Morning light, dew
> droplets, a little field dust on the leaf, blurred crop rows as bokeh background.
> Realistic phone-macro look: shallow depth of field, slight focus miss, mild
> sensor noise. No text, no logos, no people beyond the gloved fingertip.

**The tells:** pear-shaped clustered aphids vs. alligator-shaped orange-flecked
ladybird larvae. **Ambiguity:** larvae partly shadowed/soft so "62% outbreak" is
believable — at a glance they read as bigger pests. **Avoid:** textbook entomology
sharpness, single-insect portraits, lab look.

## 7. `floor.png` — "Resident is on the floor, not responding to a greeting. Call for help?" (home humanoid)

**Role:** chest-height camera frame from a home robot. Verdict: *no emergency —
exercise mat, lit phone screen, workout clothes; she is mid-routine. Check again in
ten minutes.* The story is the robot knowing to ask instead of false-alarming 911.

**Prompt seed:**
> Indoor frame from a home robot's chest-height camera, slightly wide-angle: a
> normal living room in soft daytime window light, a person lying face-down and
> motionless on the floor, face fully turned away and not visible, wearing everyday
> athleisure. The scene is deliberately ambiguous: a partially unrolled exercise
> mat under their torso and a phone propped against a water bottle with the screen
> lit — but also one overturned slipper and a cushion fallen from the couch nearby.
> Mild wide-angle distortion and indoor sensor noise, robot-camera flatness. The
> person must be unidentifiable: no face, generic build, no tattoos or distinctive
> features. No text, no logos.

**The tells:** mat + lit phone + workout wear → floor exercise. The slipper and
cushion keep a fall classifier honestly stuck around 55%. **Avoid — hard lines:**
blood, injury, distress, or elderly-in-trouble framing (the resolution is benign);
no children; no visible face. If it drifts toward "collapsed victim," regenerate —
the image must read calm once you spot the mat.

## 8. `pills.png` — "She asked for her heart pill — two identical white pills on the counter. Which one?" (home care robot)

**Role:** chest-height camera frame from a home care robot. Verdict: *the scored
pill with the faint imprint matches the heart-med bottle; the blank one is the
supplement — confirm the imprint before she takes it, and flag the caregiver to
store them separately.* Design note: pill-ID by imprint is a database (fails the
entry test); the untrainable part is reading worn/glared evidence in a messy home
frame — and holding safely when it can't be read.

**Prompt seed:**
> Indoor frame from a home robot's chest-height camera, slight downward angle onto
> a kitchen counter in soft window light: two small white round pills side by side,
> nearly identical in size and shape. One pill has a faint score line across it and
> a partially worn imprint that only barely catches the raking light — a single
> letter at most, not a full readable code. The other pill is completely smooth and
> blank. Context around them, slightly behind the pills: an amber prescription
> bottle with its cap off and label turned away from camera, a white supplement jar
> with its label also turned away, a weekly pill organizer with one compartment
> open, and a glass of water. No readable text anywhere in frame — all labels
> turned or out of focus. Mild wide-angle distortion, indoor sensor noise,
> realistic counter clutter. No hands, no people, no brand marks.

**The tells:** faint score line + partial imprint on one pill vs. the perfectly
blank other; the two containers as context. **Ambiguity:** pills ~95% identical at
a glance, imprint visible only in the raking light — a 55% classifier is believable;
a human who zooms gets there. **Avoid — hard lines:** no fully legible imprint code
(real codes identify real products), no readable labels, no colorful distinct pills,
no pharmacy setting, no hands or people.

## 9. `listings.png` — "Two listings, one UPC. Same product?" (catalog agent)

**Role:** the two product photos a marketplace catalog agent is comparing — same
invented gin brand in old vs. refreshed packaging, presented side by side as one
frame. Verdict: *merge — same product, label refresh; keep the newer image.*
(Modeled on a real same-UPC duplicate found in a live delivery catalog; the real
brand can't appear on our site, so the brand is invented.)

**Prompt seed:**
> Single image composed as two side-by-side e-commerce product photos on a clean
> white background, thin dividing line between panels, like a catalog comparison
> tool. Both panels show the same 750 ml clear-glass gin bottle of a completely
> fictional brand called "ALDERTON'S" — bold readable brand name, no resemblance
> to any real gin brand's colors or crest. LEFT panel: the older packaging — a
> slightly dated label design with a cluttered oval crest, beige-and-navy palette,
> serif type, a small "award" ribbon graphic. RIGHT panel: the refreshed packaging
> of the same brand — cleaner modern label, same navy palette simplified, same
> brand name, subtle botanical line illustration, slightly taller-looking neck
> label. Identical bottle size in both panels. Studio product lighting, soft
> shadows, true e-commerce style. The only legible text is the brand name
> "ALDERTON'S" and "LONDON DRY GIN" — no barcodes, no UPC digits, no proof
> statements legible, no other readable text.

**The tells:** same brand name and variant on both labels; same bottle volume;
everything else (label style, crest, colors) differs. **Ambiguity:** the two
panels should look different enough at a glance that "different products" is a
plausible model call — the resolution is reading the labels. **Avoid — hard
lines:** any real gin trade dress (Gordon's yellow/green, Tanqueray green,
Beefeater red, Bombay blue), legible barcodes or numeric codes, more than the
two short lines of readable text (generation models garble longer text).

---

## Optional video loops (progressive enhancement, not required)

Same scenes as `flood` and `cones`, as **3–5 second seamless loops**, camera locked:
- `flood.webm`: rain falling, faint ripples crossing the floodwater, brake lights of
  the turning car glowing/holding. No camera movement.
- `cones.webm`: nearly static; subtle micro-vibration of the AV camera, faint heat
  or moisture shimmer on the wet concrete.
- Specs: 1920px wide min, no audio, H.264 + WebM, ≤1 MB each after compression,
  loop point invisible. Same grade as the stills.

## Acceptance checklist (run per asset before sending)

- [ ] Survives a 2.91:1 center crop with the story intact; top-left low-detail
- [ ] No text/logos/watermarks/HUD anywhere; no faces; no readable plates
- [ ] The verdict is checkable in-image; the stated model confidence is believable
- [ ] No AI artifacts (warped geometry, gibberish glyphs, melted edges) at 2× zoom
- [ ] Grade matches the set (muted, desaturated, neutral-cool, natural grain)

## Integration (mine, once assets land)

Drop files in `public/frames/`, I swap each card's inline SVG for a `<picture>`
(AVIF/WebP + fallback), keep the SVGs as no-image fallback, lazy-load all but the
first frame, preload the default card's image, and re-verify page weight + LCP.
