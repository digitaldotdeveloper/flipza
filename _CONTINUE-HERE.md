# Flipza — where this stands

A pizza storefront that is **one screen with no scrolling**. The pizza on the
peel is the product view, choosing a flavour tosses it, and the toss is the
transition between every state rather than a decoration on top of one. Behind
it the oven fire burns continuously. You order by tapping through four steps
and the pizza goes into a box in front of you.

**Run it:** `npm run dev` → <http://localhost:5173>
**Ship a single file:** `npm run standalone` → `flipza.html`, double-click
**Deploy:** `npm run deploy` → builds and pushes `dist/` to the `gh-pages` branch
**Add a flavour:** `node scripts/gen-flavor.mjs <flavour>` then `npm run to-webp`
**Screenshots:** `node tools/shot.mjs <scene> [W] [H]` (scenes listed in the file)

**On this machine, open it as `?motion=on`** — otherwise the pizza cuts between
flavours, the fire holds on one frame and the box sequence is skipped. See
*reduced motion* below; it is an OS setting, not a bug.

Last worked on 2026-09-20.

---

## How it fits together

```
src/scene.ts                    the toss as a pure function of one number
src/menu.ts                     flavours, sizes, extras, prices, order maths
src/props.ts                    the generated props: fire, plate, box, toppings
src/render/renderer.ts          every layer that is drawn, from one state object
src/render/loader.ts            critical assets first, the rest streamed behind
src/components/OrderScene.tsx   the order machine + the animated sequences
src/components/Dock.tsx         step rail, sliding panels, the one CTA
src/components/OrderList.tsx    the order itself
src/components/Placed.tsx       the confirmation

sprites-src/     pizza-<flavour>-1..9, peel, plate         (lossless WebP)
oven-src/        flame-00..10, embers                       "
props-src/       box-open / box-closed, side-fries / side-cola, topping sheets
portrait-src/    portrait (the vertical outpaint)

scripts/studio.mjs        the Gemini Studio client all generators share
scripts/geometry.mjs      measurements shared between generate and prepare
scripts/sources.mjs       find a source whatever extension it was stored as
scripts/gen-flavor.mjs    repaints toppings onto the nine poses
scripts/gen-oven.mjs      the flames, and the oven with its fire put out
scripts/gen-props.mjs     the box and the topping sheets
scripts/gen-portrait.mjs  the kitchen extended vertically
scripts/prepare-*.mjs     key, measure, cut and pack all of it into public/
scripts/to-webp.mjs       PNG sources -> lossless WebP
tools/shot.mjs            drive the site through CDP and screenshot it
tools/probe.mjs           run one expression inside the running page
```

`npm run prepare-all` runs the four prepare scripts in dependency order:
oven (flameless plate) → portrait (extends it) → props → assets (encodes it).
`npm run dev` does that first.

Two generated manifests: `src/sprite-data.json` (poses, including each pose's
ellipse) and `src/prop-data.json` (fire, plate geometry, box frames and hinge,
sides, topping counts). Both are written by scripts and read by the runtime;
neither is edited by hand.

`window.__flipza` exists in a dev build - state, plan, renderer and assets -
which is what `tools/probe.mjs` reads. It is the fastest way to answer "what
does the renderer actually think is there", and it found the silent
topping-loading bug below in one run.

---

## The one idea the whole thing rests on

The nine poses are one continuous toss, and originally they baked *rotation and
flavour together*: pose 5 was a half-margherita/half-pepperoni render. One
sprite set therefore meant one ordered **pair** of flavours, and covering six
flavours that way is 30 pairs × 9 poses = 270 renders.

Now every flavour is rendered through the **same nine rotations**, so any
flavour can be swapped for any other partway through a toss and the pizza
carries on turning as if nothing happened. Six flavours is 54 sprites, not 270,
and all 30 transitions work. Sprite count grows with the number of flavours, not
with the number of pairs of them.

This is why `gen-flavor.mjs` *edits* the existing poses instead of generating
new ones: handing Gemini the pose and asking it to repaint only the toppings
preserves the rotation by construction.

**The same trick is what makes the fire work**, and it is worth seeing that they
are the same trick. Ten independently prompted flames came back as ten
different fires - different colour, different style, one of them a candle - and
cutting between them read as a fault. Generating every frame *from one flame as
reference*, asking for "the same fire a fraction of a second later", anchors
them all to one look exactly the way the poses are anchored to one rotation.
`gen-oven.mjs --seed <file>` is that mode, and it is the one to use.

---

## The timeline is cyclic

`scene.ts` runs on a cyclic timeline: **every whole number is a pizza resting on
the peel, and each unit interval is one complete toss**. `plan[n]` is the
flavour landed at position `n`; choosing a flavour appends to it and advances
`p` by one. That is what makes tosses **chain** — press three flavours quickly
and the pizza keeps tumbling through all three. Choosing again *before* the swap
point re-aims the toss already in the air for free.

Two details that are easy to break:

- **`SWAP_AT = 0.375`, deliberately not the apex.** `p` is tweened linearly
  against a parabola, so vertical speed is **zero** at the apex — the pizza
  hangs there at its largest, moving slowest. That is the most visible moment in
  the toss and the worst place to change anything. 0.375 is pose 4 on the way
  up: still moving fast enough to carry motion blur, and one of the most
  foreshortened poses, so the least topping is facing camera when it changes.
- **Pose index wraps** (`round(t * POSE_COUNT) % POSE_COUNT`). The modulo closes
  the cycle so a landed pizza is always pose 1. Without it the pizza settles on
  pose 9 and silently switches to pose 1 the instant it comes to rest — a change
  of shape at the one moment nothing else is moving to hide it.

---

## The ordering flow

Four steps in a dock along the bottom, and each one is a thing that happens on
the counter rather than a control that changes a number:

| step | the tap does | the scene does |
| --- | --- | --- |
| flavour | picks the pizza | tosses it |
| size | S / M / L | the pizza grows on the peel |
| extras | toggles a topping | that topping rains down and **stays on it** |
| add to order | commits the pizza | box slides in, peel pulls out, pizza drops in, lid closes, box goes back to the pile |
| order | quantities, delivery, the meal | fries and a cola are set down beside the pile |

Everything ordered stays on screen: the boxes pile up at the back of the
counter and the sides stand beside them, so what has been bought is visible
while it is being paid for rather than only listed. **There is no payment and no
kitchen at the other end** — it is a storefront demo and the confirmation says
so. Do not add a card form to it.

Four things worth not re-deciding:

- **The extras stay on the pizza.** They used to melt in a moment after landing,
  which looked fine and was exactly wrong: the reason to watch a topping land is
  to see it on the pizza you are about to buy, and again at checkout. Keeping
  them means projecting them - see *toppings that stay* below.
- **The lid is computed, not photographed.** See *the lid* below; two batches of
  generated in-between frames failed before this was accepted.
- **The pile stands at the back of the counter**, not the near edge. On a phone
  the order step opens the tallest dock of the four and anything near the camera
  ends up behind it - the back of the counter is both where finished boxes would
  actually go and the only part a phone can still see at checkout. On a wide
  screen the whole group slides 150px right, off the oven mouth and onto the
  clear stretch of counter that only a wide window can see.
- **The dock is not dimmed while a sequence plays**, only made non-interactive.
  Dimming it reads as an error rather than as a wait.

## Toppings that stay

A pizza is a flat disc, and a flat disc seen at an angle is an ellipse.
`prepare-assets` measures that ellipse for every pose - both axes, and now the
**direction of the long one** (`angle` in sprite-data.json, from the same second
moments the axes come from). So an extra is stored as a position on a *unit
disc* - the pizza's own coordinates - and every frame that position is mapped
onto whichever ellipse the pizza is currently showing, with the piece squashed
by the same `minor/major` it would be if it were lying on that surface.

That is what makes it read as *on* the pizza rather than in front of it: near
the top of the toss, where the pizza is nearly edge-on, its toppings are nearly
edge-on too. It works because **all nine poses show the topped side** - the
pizza tilts and turns but never shows its underside, so there is never a frame
where the toppings should be hidden. Check that before generating a tenth pose.

The spin of the pizza about its own axis is not modelled, and does not need to
be: the scatter is random, so there is no pattern to give it away.

## Into the box

The add-to-order sequence is the one moment worth watching, and for a while it
was not watchable. Three things were wrong and all three are worth keeping in
mind if it is ever re-timed:

- **The box was drawn over the pizza.** One `drawImage` of the whole box, after
  the pizza - so the lid standing at the back covered the pizza, and so did the
  inside of the tray. It read as a box appearing in front of a pizza. The box
  is now drawn in **two passes** with the pizza between them, split at the
  `front` line from prop-data: the lid and the tray floor behind, the tray's
  near wall in front. That is what being *in* a box means.
- **The pizza landed where it always lands.** The toss ended at the same rest
  point as every other toss and the box happened to be around it. `dropIn` now
  eases the last of the arc down to the tray floor and shrinks the pizza to fit
  between the tray walls, so it settles *into* the box.
- **The lid started closing twenty milliseconds after the pizza landed.** The
  one frame worth seeing - the pizza you just built, in an open box - was never
  on screen. There is now a held beat of four tenths of a second where nothing
  moves at all. The stillness is the animation.

The contact shadow fades out with `dropIn`: that shadow falls on the counter,
and once the pizza is in the box there is a cardboard floor a few inches under
it instead.

## The lid

It is not a set of photographs, and not for want of trying. Two batches were
generated of the same box with its lid a quarter, a third, a half and three
quarters of the way down. What came back both times was the lid still standing
up, or leaning off to one side - **from this camera a lid rotating about a hinge
at the back mostly foreshortens rather than sweeps**, and that turns out to be a
very hard thing to ask a generator for. Describing it as appearance rather than
as mechanism ("it gets shorter from top to bottom, it stays exactly as wide, it
must not tilt left or right") did not fix it either.

So the in-between is computed. `prepare-props` finds the hinge from the width
profile - the lid stands roughly straight up so its width barely changes down
its length, while the base widens towards the camera, and the boundary is the
one row where the silhouette jumps (508px to 550px on this art, at 0.638 of the
height). The renderer draws the base where it always is and the lid above it
squashed towards the hinge by `cos`, which is exactly what the projection of a
rotating lid does - and unlike a generated frame it can be put at any angle at
any moment. The shut box then fades in over the last of the fall, because a lid
squashed to nothing is a line across the back of the box where a shut box is a
lid lying over the whole base.

Only two frames are therefore needed, `box-open` and `box-closed`, and they are
registered on their **base** by prepare-props - not on their centroid, which an
open lid leaning back drags sideways - and scaled so their bases come out the
same width, because separate photographs come back a few per cent apart.

---

## The fire

`public/fire/flame-NN.webp`, composited into the oven mouth with `lighter`.

- The plate had a fire **painted into it**. Animated flames over painted ones
  read as two fires, so `gen-oven.mjs` also generates the cavity with the fire
  put out and `prepare-oven.mjs` patches it back in — through an arch-shaped
  mask that is eroded and feathered, after nudging the generated crop into
  alignment against the *bricks*, which are the part that did not change.
  Only the interior is replaced; the arch is original pixels.
- Flames are keyed with a **ramp, not a threshold**. A hard key is right for a
  pizza, which has a definite edge; fire does not have one, and a threshold
  leaves a flame with a crisp outline, the one thing fire never has.
- Transparent pixels are bled to **black**, not to a mean colour, because the
  frames are composited additively and black adds nothing. That makes WebP
  smearing colour past the flame edge harmless — the opposite of the pizza
  sprites, where the same smear is the whole problem.
- Frames are sorted by how much flame there is and then walked **up and back
  down**, so consecutive frames are neighbours in size and the loop has no seam.
  Eleven frames a second, cross-faded; faster and it stops reading as one fire.
- The room reacts: per-frame brightness is measured at build time and drives a
  warm radial spill over the whole plate. Without it the flames are a video
  playing inside a photograph.

---

## The mobile question — answered

The plate was 1672×941 (16:9) against a phone's ~9:19.5. Cover-fitting cropped
~74% of the width — the pizza is 500 plate px across and only ~435 would have
been on screen. Zooming out makes it *worse*: the further out the scene is
fitted, the more plate height the window needs.

The fix is the one the old version of this file proposed: **a taller plate**.
`gen-portrait.mjs` outpaints the kitchen to 1672×2021 — 560px of ceiling above,
520px of counter in front — and `prepare-portrait.mjs` composites the original
middle back over it at full resolution, so only ceiling and counter are ever
upscaled from a 1024px generation. The seam is a ramp, and each strip is
levelled to the original by the ratio measured at the seam before it is joined.

Three things fall out of that:

- `PLATE_IMAGE` in `prop-data.json` says where the scene's origin sits inside
  the bitmap. Scene coordinates are still the original 1672×941 kitchen; y runs
  **negative** up into the new ceiling.
- The view aims one scene point at one screen fraction and then clamps so the
  bitmap never pulls away from an edge. In landscape that lands the original
  kitchen almost exactly in a 16:9 window. In portrait the clamp takes over and
  the whole picture is on screen.
- **The actors are lifted on narrow screens** (`LIFT_MAX`, 90 plate px). The
  dock covers the bottom three tenths of a phone and the pizza rests low in a
  tall frame, so without the lift it sits behind the controls. A peel held a
  little above the counter is what someone holding a peel looks like.

The phone layout also moves the readout **to the top**, under the logo. It wants
to be at the bottom and on a wide screen it is, but on a phone the gap between
the resting pizza and the dock is about twenty pixels — anything put there lands
on the peel. The ceiling is dark, empty, and the one place cream text is
completely legible.

---

## Loading

The old loader blocked on all 64 bitmaps before the first frame. Now:

- **critical**: plate, peel, and pose 1 of every flavour — about 8 images,
  ~600KB. Enough to draw a resting pizza and let someone tap.
- **streamed**: the fire, then poses 2..9 per flavour, then the toppings, then
  the box and the sides — in the order each can first be *seen*, which is not
  the order each can first be needed.
- Every group is a `once()` promise, so anything reachable early can be pulled
  forward and the stream simply awaits the same promise: `ensure(flavour)` when
  a flavour is tapped, `ensureToppings()` when the extras step opens. Tapping an
  extra that has not streamed in yet waits for it rather than doing nothing.

**Order it by what is seen, and let taps jump the queue.** Both halves of that
were learned the hard way. The fire went last on the theory that nothing needs
it - and it arrived eight seconds into a cold load, so the oven was a photograph
of embers for the whole first impression. Then the toppings went last on the
same theory, and tapping an extra silently did nothing for the first ten
seconds: `rain()` returns quietly when the pieces are not there, nothing errors,
and it took a `tools/probe.mjs` session to find. If a feature is doing nothing
and there is no error, look at where its assets are in this queue first.

Total download on a normal screen **3.4MB**, down from 6.7MB, and about 600KB of
that before the page is interactive. Four things got it there:

- the bare `pizza-1..9` sprites are no longer emitted at all - they are
  *sources*, which `gen-flavor.mjs` repaints into the per-flavour sets, and the
  runtime only ever asks for `pizza-<flavour>-<n>`. 2.2MB of files nothing had
  ever requested.
- **two sprite sets**, `sprites/` capped at 620px and `sprites-2x/` at 980px,
  chosen in scene.ts from the window and the plate together (what matters is how
  many real pixels the pizza ends up covering). Only one is ever downloaded.
  sprite-data.json describes the standard set and the renderer rescales the
  measurements by whatever bitmap arrived, so nothing else knows which set it is.
- **pose 1 is encoded well and poses 2-9 are not** (86 against 62). They are not
  looked at for remotely similar lengths of time: pose 1 is on screen for the
  whole order, while poses 2 to 9 each appear for about seventy milliseconds
  under motion blur - and they are eight ninths of the bytes. This is worth more
  than the resolution cap was: capping 960 → 620 only took 6% off, because the
  bytes were in the quality, not the pixels.
- the plate is encoded at quality 80 and is 188KB for 1672x2021.

---

## Facts that cost real debugging — don't re-derive

**Getting a cut-out back at all**
- Asking Gemini for a **transparent background makes it paint a checkerboard** —
  a literal picture of what transparency looks like in an image editor, opaque
  and two-toned, the worst possible thing to key. Ask for flat magenta instead.
- Gemini stamps a small **sparkle watermark** in a corner. It sits on the
  background, so keying leaves it as a second island — which widens the trim box
  and drags the alpha centroid off the pizza. `keepLargestBlob()` removes it.
- **Key toppings globally, key pizzas by flood fill.** An olive ring has a hole
  in the middle, and that hole is background a flood fill from the border can
  never walk to — so a flood fill leaves every olive with a magenta centre. The
  pizza sprites need the flood fill for the opposite reason: a global match
  would punch through anything on the pizza that happened to be near the key.

**The pink halo, which took three attempts**
- Keying only sets alpha to zero; **the magenta is still sitting in the RGB
  channels**, invisible until lossy WebP smears it back across the alpha
  boundary. Proved by encoding lossless: 0 contaminated pixels vs ~800 per
  sprite.
- Bleeding a 4px margin is **not enough** — WebP carries chroma at half
  resolution and encodes in 16×16 blocks, so it drags colour a dozen pixels.
  `bleedEdges()` grows a gradient out from the crust and floods everything past
  it with the sprite's mean colour.
- A bright hairline still traced the crust, because **magenta raises red as much
  as it raises blue**. There is no clean colour to recover in those pixels —
  `CHROMA_ERODE = 4` throws them away instead.
- **Every sprite is bled now, not only the keyed ones.** A source that arrived
  with its own cut-out has invisible RGB too, and a lossless WebP re-encode
  legitimately zeroes it — which left the peel with black bleeding into its edge
  instead of its own grey. Bleeding unconditionally makes the output depend only
  on pixels that are actually visible in the source.

**"It swaps flavour but never flips" — reduced motion, and it is the default here**
- **Windows Server ships with "Show animations in Windows" off.** Chrome maps
  that to `prefers-reduced-motion: reduce`, and the toss duration is deliberately
  `0` under reduce — so the pizza cuts between flavours, the fire holds a frame,
  the box sequence is skipped, and the entire premise of the site vanishes
  silently. Nothing errors. It is not a rare preference on these machines, it is
  the default.
- **`?motion=on`** animates anyway without touching an OS-wide setting;
  `?slow=N` implies it. Honouring the preference stays the default.
- Check it from PowerShell with `SystemParametersInfo(SPI_GETCLIENTAREAANIMATION
  = 0x1042)` — `False` means Chrome will report reduce.

**Playwright lies about reduced motion — this cost the most time of anything here**
- `chromium.launch()` **overrides the media query to `no-preference` by
  default**. An automated browser therefore animates perfectly while the real
  browser beside it, same machine, same file, does not.
- Pass **`newContext({ reducedMotion: 'no-override' })`** to see what the machine
  actually reports.
- The general lesson: when the screen disagrees with an automated test, suspect
  the automation's emulation defaults before inventing a mechanism.

**Screenshots of an animation drift**
- `tools/shot.mjs` has `wait` and `at`. Use **`at`**, which waits until the clock
  says so rather than sleeping for a fixed time: capturing a 390×844 page at 2x
  costs a few hundred milliseconds, and a scene built out of `wait` steps falls
  further behind with every frame it takes. `at` can only wait, never rewind, so
  a sequence with several captures still drifts late — to pin one exact moment,
  shoot it on its own run.
- Emulate the device with `Emulation.setDeviceMetricsOverride`, never
  `--window-size`. A headless window at 390×844 gives the desktop layout scaled
  down, which is a picture of the wrong thing.

**Verifying a generation actually worked**
- The check that matters is the **minor/major axis ratio** in `sprite-data.json`
  against the same pose in the originals — `node scripts/check-poses.mjs` flags
  anything past 2%. It measures foreshortening, i.e. whether Gemini kept the
  tilt. Position and size drift are harmless (`measureSprite` normalises both);
  rotation drift is not.
- A pose that matches is *very* precisely equal: four generated pose 1s key to
  an identical 562×259 silhouette. Independent generations agreeing to the pixel
  looks like a bug — it is what the prompt succeeding looks like.
- **Pose 1 reliably drifts**, and **the drift is spread, not bias — so take
  several and pick, don't retry.** That is what `best-pose.mjs` is for: it counts
  the file already on disk as take 0, so it can only improve on what it started
  with. A plain retry overwrites blind and on average loses ground.
- **Formaggi pose 1 never converged: +9.6%** across twelve takes. Its prompt asks
  for the largest repaint of any flavour (*no tomato sauce at all*), and the
  further the toppings move from the source the less the geometry is anchored to
  it. If it ever needs fixing, change the prompt rather than spending takes.

**Keying: magenta lifts red and blue together**
- Clamping blue alone - the first despill - turns spill from pink into red and
  leaves it exactly as visible. What separates spill from something genuinely
  red is that a chilli or a red carton has its blue down near its green, while a
  white cup with magenta bouncing off it has *both* above green. So the rule is
  both-above-green, and both are pulled back to it.
- That only fixes spill on the way out. A white object generated on a magenta
  background can come back **actually pink**, which is not a keying problem at
  all - the generator lit it that way. The prompt has to say so: "lit only by
  that warm indoor light, the background colour must not tint it anywhere,
  white card stays pure white".

**React runs a state updater twice in development**
- Which means an updater that also starts an animation starts it twice. This
  showed up as double toppings and was easy to miss, because in production it
  is right. Side effects go outside the updater, and anything they need from
  the current state comes from a ref.

**Sources are WebP now**
- Lossless WebP is **the same pixels** as the PNG in about 40% of the bytes, and
  every measurement downstream comes out identical. The one exception is RGB
  under fully transparent pixels, which it zeroes — see the bleeding note above.
- Generators still write PNG, because that is what comes back from Gemini.
  `npm run to-webp` converts; `scripts/sources.mjs` means every reader accepts
  either. The PNGs are kept on disk and out of the repository.

---

## Not finished

- **The chalkboard is still a photograph.** It lists the six flavours on the
  wall and the dock lists them again underneath. Making the board itself the
  picker is the single best idea left in this project — a six-way segmented
  control looks like every other website, a chalkboard does not. The menu order
  in `scene.ts` already matches the board, so they can no longer disagree.
- **The neon sign could be the readout.** The pile at the back of the counter
  is already the cart.
- **The pizza in the box is only briefly visible.** The lid closes over it about
  four tenths of a second after it lands. Holding it open a beat longer - or
  leaving the top box of the pile open - would show more of what was just
  built.
- **Sound.** A whoosh, a slap on landing, the fire. Muted by default. Half of
  what would make this feel expensive.
- **The menu does not exist as text.** A canvas-only site is invisible to
  search; if this were ever a real shop the flavours and prices need to be in
  the DOM. `menu.ts` already has all of it, so this is a rendering job, not a
  data one.
- **`flipza.html` (standalone) has not been rebuilt** since the fire and the
  props were added; it will be considerably bigger than the 8.76MB it was.

## Gotchas when picking this back up

- `npm run dev` runs the whole prepare chain first. Don't run another script
  that reads `public/` at the same time — sharp will fail with "unable to open
  for write" on a half-rebuilt file. That is a race, not a real bug.
- A flavour missing any pose is **skipped with a warning**, not an error, since a
  half-generated flavour is the normal state while a batch is running.
- `prepare-assets` skips keying for any source that already has real alpha, so
  the original `peel` passes through untouched.
- The Gemini Studio dashboard must be running at `http://127.0.0.1:4321` for any
  `gen-*` script, with a token from Settings → API tokens in
  `GEMINI_STUDIO_TOKEN`.
- A generation batch is queued first and waited on afterwards — the dashboard
  runs two at a time, so ten submitted together finish far sooner than ten
  submitted one after another. Expect roughly 25s per image.
