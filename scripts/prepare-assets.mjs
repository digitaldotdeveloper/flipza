/**
 * Builds the runtime assets for the hero. Sources are only ever read - never
 * modified, moved or deleted.
 *
 *   sprites-src/peel.png       ->  public/sprites/peel.webp
 *   sprites-src/pizza-1..9.png ->  public/sprites/pizza-1..9.webp
 *   frames-src/01..12.png      ->  public/plate.webp        (stand-in only)
 *   logo.png                   ->  public/logo.webp
 *                              ->  src/sprite-data.json
 *
 * The pizza sprites are nine poses of one continuous toss, cut out on alpha.
 * They arrive on a big transparent canvas at whatever size and offset the
 * generator happened to use, which is useless for animation - so each is
 * trimmed to its alpha bounds and measured: the centroid gives a stable anchor
 * to position it by, and the major axis of its alpha mask gives a diameter to
 * normalise against, so the runtime can place and scale every pose on one
 * consistent arc instead of inheriting nine unrelated framings.
 */
import { mkdir, stat, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { pickSource, requireSource } from './sources.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spriteSrc = path.join(root, 'sprites-src')
const spriteOut = path.join(root, 'public', 'sprites')
const publicDir = path.join(root, 'public')

const POSES = 9
const SPRITE_QUALITY = 82

/**
 * Two sprite sets, and the pizza's own diameter in each, in sprite pixels.
 *
 * The pizza is drawn about 500 plate pixels across and the plate is scaled to
 * fill the window, so what a sprite is actually asked for is roughly
 * 500 x 1.36 x (window / plate) - about 570px on a 1080p desktop and on a
 * phone, and about 1500px on a 4K display. One set sized for the largest of
 * those is most of a megabyte wasted on everyone else: at 960px the sprites
 * come to 3.2MB, and nine screens in ten can only show half of it.
 *
 * So `sprites/` is sized for a normal screen and `sprites-2x/` for a big or
 * dense one, and the runtime picks (see scene.ts). Only one set is ever
 * downloaded. sprite-data.json describes the standard one; the renderer scales
 * the measurements by the bitmap it actually got, so the same numbers serve
 * both.
 */
const SETS = [
  { dir: 'sprites', maxMajor: 620, rest: 86, tumble: 62 },
  { dir: 'sprites-2x', maxMajor: 980, rest: 84, tumble: 60 },
]

/**
 * Pose 1 is encoded well and poses 2-9 are not, on purpose.
 *
 * They are not looked at for remotely similar lengths of time. Pose 1 is the
 * pizza sitting on the peel - it is on screen while someone reads the menu,
 * picks a size, adds toppings and checks out, which is minutes. Poses 2 to 9
 * each appear for about seventy milliseconds, in the middle of a tumble, under
 * motion blur that the renderer adds on top.
 *
 * They are also eight ninths of the bytes. Encoding the eight that flash past
 * at the quality the one you stare at needs is most of a megabyte spent on
 * frames nobody can see clearly anyway.
 */
const isResting = (name) => name === 'peel' || /-1$/.test(name)
/** Alpha at or below this is treated as fully transparent when measuring. */
const ALPHA_FLOOR = 24

/**
 * Chroma keying, for the flavour sprites that come back from Gemini.
 *
 * The generator will not return real transparency - asked for it, it paints a
 * picture of a checkerboard - so scripts/gen-flavor.mjs asks for flat magenta
 * instead and the background is lifted here. Magenta is used because nothing on
 * a pizza is remotely near it, so the fill can be given a wide tolerance and
 * still stop dead at the crust.
 */
const CHROMA_TOLERANCE = 70
/** Rings of spill-contaminated pixels discarded inwards from the keyed area. */
const CHROMA_ERODE = 4
/** Rings past the erosion faded out, so the new edge is not hard. */
const CHROMA_SOFT = 2
/** Any magenta surviving on the softened edge shows as blue; pull it back. */
const DESPILL_HEADROOM = 20

/** Region of the 1254x1254 brand sheet that holds the primary lockup. */
const LOGO_CROP = { left: 236, top: 120, width: 800, height: 720 }
const KEY_TOLERANCE = 26
const KEY_FEATHER = 72
const LOGO_WIDTH = 560

async function isFresh(src, dest) {
  try {
    const [a, b] = await Promise.all([stat(src), stat(dest)])
    return b.mtimeMs >= a.mtimeMs
  } catch {
    return false
  }
}

/** Decodes an image to a mutable RGBA buffer. */
async function loadRGBA(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Whether an image already carries a usable cut-out of its own. */
function alreadyCut({ data }) {
  let clear = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] <= ALPHA_FLOOR) clear++
  return clear > (data.length / 4) * 0.02
}

/**
 * Lifts a flat chroma background off a generated sprite, in place.
 *
 * A flood fill seeded from the border, not a global colour match, for the same
 * reason the logo keyer uses one: anything the fill cannot walk to is safe. It
 * also samples the background colour off the border rather than assuming
 * #FF00FF, so a generation that drifts a few points still keys.
 */
function keyChroma(img) {
  const { data, width: w, height: h } = img

  // Median of the border ring - robust against the pizza touching an edge,
  // which would drag a mean off the true background colour.
  const ring = [[], [], []]
  const sample = (i) => {
    for (let c = 0; c < 3; c++) ring[c].push(data[i * 4 + c])
  }
  for (let x = 0; x < w; x++) {
    sample(x)
    sample((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    sample(y * w)
    sample(y * w + w - 1)
  }
  const bg = ring.map((c) => c.sort((a, b) => a - b)[c.length >> 1])

  const distSq = (i) => {
    const o = i * 4
    const dr = data[o] - bg[0]
    const dg = data[o + 1] - bg[1]
    const db = data[o + 2] - bg[2]
    return dr * dr + dg * dg + db * db
  }

  const outside = new Uint8Array(w * h)
  const stack = []
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)

  const tolSq = CHROMA_TOLERANCE * CHROMA_TOLERANCE
  while (stack.length) {
    const i = stack.pop()
    if (outside[i] || distSq(i) > tolSq) continue
    outside[i] = 1
    const x = i % w
    const y = (i - x) / w
    if (x > 0) stack.push(i - 1)
    if (x < w - 1) stack.push(i + 1)
    if (y > 0) stack.push(i - w)
    if (y < h - 1) stack.push(i + w)
  }

  // Magenta contaminates more than the single outermost ring: the generator's
  // own antialiasing runs a few pixels deep, and a pixel that is 40% magenta is
  // already too far from the key colour for the flood fill to claim.
  //
  // Those pixels are thrown away rather than colour-corrected. Correcting them
  // does not work: magenta raises red as much as it raises blue, so capping
  // blue alone turns a bright pink hairline into a bright red one (measured at
  // R-G 184 on the crust), and capping red as well desaturates the genuinely
  // warm crust behind it. There is no clean colour in those pixels to recover.
  // Eroding a couple of pixels costs nothing - the sprite is normalised on its
  // major axis afterwards, so a fractionally smaller pizza is scaled straight
  // back up - and it removes the problem instead of trading it.
  const band = new Uint8Array(w * h)
  let frontier = []
  const spread = (i, into, ring) => {
    const x = i % w
    const y = (i - x) / w
    const push = (j) => {
      if (outside[j] || band[j]) return
      band[j] = ring
      into.push(j)
    }
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }
  for (let i = 0; i < w * h; i++) if (outside[i]) spread(i, frontier, 1)
  for (let ring = 2; ring <= CHROMA_ERODE + CHROMA_SOFT; ring++) {
    const next = []
    for (const i of frontier) spread(i, next, ring)
    frontier = next
  }

  for (let i = 0; i < w * h; i++) {
    if (outside[i]) {
      data[i * 4 + 3] = 0
      continue
    }
    const ring = band[i]
    if (!ring) continue
    if (ring <= CHROMA_ERODE) {
      data[i * 4 + 3] = 0
      continue
    }
    // The rings just inside the erosion are the new outer edge. They carry far
    // less spill, but they are still the boundary, so they get softened to keep
    // the cut-out from turning hard and jagged, and their blue is capped in
    // case a trace of magenta survived.
    const o = i * 4
    const t = (ring - CHROMA_ERODE) / (CHROMA_SOFT + 1)
    data[o + 3] = Math.round(data[o + 3] * t)
    const cap = data[o + 1] + DESPILL_HEADROOM
    if (data[o + 2] > cap) data[o + 2] = cap
  }
}

/**
 * Keeps the largest connected blob and erases everything else, in place.
 *
 * Gemini stamps a small sparkle watermark in a corner of what it generates.
 * It sits on the background, so keying leaves it behind as a second island -
 * and being an island it would then widen the trim box and drag the alpha
 * centroid off the pizza, which is the one measurement everything else is
 * anchored to. The pizza is always the biggest thing in frame, so keeping only
 * the largest component removes the watermark and any other stray mark without
 * needing to know where they are.
 */
function keepLargestBlob(img) {
  const { data, width: w, height: h } = img
  const label = new Int32Array(w * h).fill(-1)
  const queue = new Int32Array(w * h)
  let best = -1
  let bestSize = 0
  let next = 0

  for (let seed = 0; seed < w * h; seed++) {
    if (label[seed] !== -1 || data[seed * 4 + 3] <= ALPHA_FLOOR) continue
    const id = next++
    let head = 0
    let tail = 0
    queue[tail++] = seed
    label[seed] = id
    let size = 0
    while (head < tail) {
      const i = queue[head++]
      size++
      const x = i % w
      const y = (i - x) / w
      const push = (j) => {
        if (label[j] === -1 && data[j * 4 + 3] > ALPHA_FLOOR) {
          label[j] = id
          queue[tail++] = j
        }
      }
      if (x > 0) push(i - 1)
      if (x < w - 1) push(i + 1)
      if (y > 0) push(i - w)
      if (y < h - 1) push(i + w)
    }
    if (size > bestSize) {
      bestSize = size
      best = id
    }
  }

  let dropped = 0
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] > ALPHA_FLOOR && label[i] !== best) {
      data[i * 4 + 3] = 0
      dropped++
    }
  }
  return { blobs: next, dropped }
}

/**
 * Spreads the sprite's own colour outwards underneath the transparent pixels.
 *
 * Keying only sets alpha to zero; the magenta is still sitting there in the RGB
 * channels, invisible until WebP encodes the colour channels lossily and
 * cheerfully smears that magenta back across the alpha boundary. The result is
 * a pink halo around every pizza that is nowhere in the PNG it was built from.
 *
 * The standard fix, and the one used here: repeatedly copy the nearest known
 * colour into the transparent margin, so whatever the codec bleeds inwards is
 * crust-coloured instead.
 *
 * A handful of rounds is NOT enough, which is worth knowing before re-tuning
 * this. WebP carries chroma at half resolution and encodes in 16x16 blocks, so
 * it will happily drag a colour a dozen pixels; a 4px margin left the halo
 * almost untouched. The rounds give a soft gradient out from the crust and
 * everything past them is flooded with the sprite's own mean colour, so there
 * is no magenta left anywhere in the RGB plane for the codec to find.
 */
function bleedEdges(img, rounds = 8) {
  const { data, width: w, height: h } = img
  const known = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) known[i] = data[i * 4 + 3] > 0 ? 1 : 0

  for (let r = 0; r < rounds; r++) {
    // Collected first and applied after, so a pixel filled this round cannot
    // seed another one in the same round - that would streak the colour along
    // the scan direction instead of growing it evenly outwards.
    const filled = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (known[i]) continue
        let n = 0
        let sr = 0
        let sg = 0
        let sb = 0
        const take = (j) => {
          if (!known[j]) return
          n++
          sr += data[j * 4]
          sg += data[j * 4 + 1]
          sb += data[j * 4 + 2]
        }
        if (x > 0) take(i - 1)
        if (x < w - 1) take(i + 1)
        if (y > 0) take(i - w)
        if (y < h - 1) take(i + w)
        if (n) filled.push(i, (sr / n) | 0, (sg / n) | 0, (sb / n) | 0)
      }
    }
    if (!filled.length) break
    for (let k = 0; k < filled.length; k += 4) {
      const i = filled[k]
      data[i * 4] = filled[k + 1]
      data[i * 4 + 1] = filled[k + 2]
      data[i * 4 + 2] = filled[k + 3]
      known[i] = 1
    }
  }

  // Flood whatever the rounds did not reach with the sprite's mean colour.
  let n = 0
  let sr = 0
  let sg = 0
  let sb = 0
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] <= ALPHA_FLOOR) continue
    n++
    sr += data[i * 4]
    sg += data[i * 4 + 1]
    sb += data[i * 4 + 2]
  }
  if (!n) return
  const mean = [(sr / n) | 0, (sg / n) | 0, (sb / n) | 0]
  for (let i = 0; i < w * h; i++) {
    if (known[i]) continue
    data[i * 4] = mean[0]
    data[i * 4 + 1] = mean[1]
    data[i * 4 + 2] = mean[2]
  }
}

/**
 * Trims a sprite to its alpha bounds and measures it.
 *
 * The centroid and the principal axes come from the image moments of the alpha
 * mask. Bounding boxes are no good here: these poses are tumbling, so a pose
 * lying diagonally across the canvas gets a much larger box than the same pizza
 * lying flat, and anchoring or scaling by that would make it jump. Moments
 * describe the shape itself, not the box around it.
 */
function measureSprite({ data, width: W, height: H }) {
  let x0 = W
  let y0 = H
  let x1 = -1
  let y1 = -1
  let m00 = 0
  let m10 = 0
  let m01 = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * 4 + 3]
      if (a <= ALPHA_FLOOR) continue
      const w = a / 255
      m00 += w
      m10 += w * x
      m01 += w * y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('sprite is fully transparent')

  const cx = m10 / m00
  const cy = m01 / m00

  let m20 = 0
  let m11 = 0
  let m02 = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * 4 + 3]
      if (a <= ALPHA_FLOOR) continue
      const w = a / 255
      const dx = x - cx
      const dy = y - cy
      m20 += w * dx * dx
      m11 += w * dx * dy
      m02 += w * dy * dy
    }
  }

  const a = m20 / m00
  const b = m11 / m00
  const c = m02 / m00
  const disc = Math.sqrt((a - c) * (a - c) + 4 * b * b)
  // For a filled ellipse the semi-axis is 2*sqrt(eigenvalue), so the full
  // major axis - the pizza's apparent diameter in this pose - is 4*sqrt(l1).
  const major = 4 * Math.sqrt((a + c + disc) / 2)
  const minor = 4 * Math.sqrt(Math.max(0, (a + c - disc) / 2))

  // Which way that major axis points, in image coordinates (y down).
  //
  // This is what lets something be placed *on* the pizza rather than in front
  // of it. A pizza is a flat disc, and a flat disc seen at an angle is an
  // ellipse: given its centre, its two axes and the direction of the long one,
  // any point on the disc can be projected onto the screen, and anything lying
  // on the disc squashes by exactly minor/major along the short axis. Without
  // the angle the other three numbers describe an ellipse that could be lying
  // any way round.
  const angle = 0.5 * Math.atan2(2 * b, a - c)

  const trim = { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
  return {
    trim,
    /** Centroid relative to the trimmed sprite, in trimmed pixels. */
    cx: cx - x0,
    cy: cy - y0,
    major,
    minor,
    angle,
  }
}

/**
 * Which flavours have a full set of poses on disk.
 *
 * Read off the filenames rather than listed in code, so generating a flavour
 * with scripts/gen-flavor.mjs is all it takes to add one - there is no second
 * place to remember to update. A flavour missing any pose is skipped with a
 * warning instead of failing the build, since a half-generated flavour is the
 * normal state of things while a batch is still running.
 */
async function discoverFlavours() {
  const files = await readdir(spriteSrc)
  const found = new Map()
  for (const f of files) {
    const m = /^pizza-([a-z0-9]+)-(\d+)\.(?:png|webp)$/.exec(f)
    if (!m) continue
    const [, slug, n] = m
    if (!found.has(slug)) found.set(slug, new Set())
    found.get(slug).add(Number(n))
  }

  const complete = []
  for (const [slug, poses] of found) {
    const missing = Array.from({ length: POSES }, (_, i) => i + 1).filter((n) => !poses.has(n))
    if (missing.length) {
      console.warn(`  ! ${slug}: skipped, missing pose(s) ${missing.join(', ')}`)
      continue
    }
    complete.push(slug)
  }
  return complete.sort()
}

async function buildSprites() {
  const flavours = await discoverFlavours()

  // The bare pizza-1..9 are *sources*, not sprites: gen-flavor.mjs repaints
  // them into the per-flavour sets and the runtime only ever asks for
  // `pizza-<flavour>-<n>`. They used to be built anyway, which put 2.2MB of
  // files into public/sprites that nothing has ever requested.
  const names = [
    'peel',
    ...flavours.flatMap((slug) =>
      Array.from({ length: POSES }, (_, i) => `pizza-${slug}-${i + 1}`)
    ),
  ]

  const sources = []
  for (const name of names) {
    sources.push({ name, file: await requireSource(spriteSrc, name, root) })
  }

  for (const set of SETS) {
    await mkdir(path.join(root, 'public', set.dir), { recursive: true })
  }

  const out = {}
  for (const { name, file } of sources) {
    const img = await loadRGBA(file)
    let note = ''
    if (!alreadyCut(img)) {
      keyChroma(img)
      const { blobs, dropped } = keepLargestBlob(img)
      if (blobs > 1) note = `  keyed, dropped ${blobs - 1} stray blob(s) (${dropped}px)`
      else note = '  keyed'
    }

    // Bled whatever the source was, not only what was just keyed.
    //
    // The colour sitting under transparent pixels is invisible until a lossy
    // WebP encode smears it back across the alpha boundary - that is the pink
    // halo this pipeline was built to kill. A source that arrived with its own
    // cut-out has that colour too, and it is not necessarily anything useful:
    // a lossless WebP re-encode legitimately zeroes RGB wherever alpha is
    // zero, since none of it can be seen, which would leave the peel with
    // black bleeding into its edge instead of its own grey. Bleeding
    // unconditionally makes the output depend only on the pixels that are
    // actually visible in the source.
    bleedEdges(img)

    const m = measureSprite(img)

    // Every measurement is scaled with the sprite rather than re-measured
    // afterwards: the centroid and the axes are what the runtime places and
    // normalises by, and re-measuring a resampled alpha channel would move
    // them by a fraction of a pixel for no reason.
    for (const set of SETS) {
      const shrink = m.major > set.maxMajor ? set.maxMajor / m.major : 1
      const width = Math.max(1, Math.round(m.trim.width * shrink))
      const height = Math.max(1, Math.round(m.trim.height * shrink))

      let pipeline = sharp(img.data, {
        raw: { width: img.width, height: img.height, channels: 4 },
      }).extract(m.trim)
      if (shrink < 1) pipeline = pipeline.resize(width, height)
      await pipeline
        .webp({
          quality: isResting(name) ? set.rest : set.tumble,
          alphaQuality: 100,
          smartSubsample: true,
        })
        .toFile(path.join(root, 'public', set.dir, `${name}.webp`))

      // The standard set is the one sprite-data.json describes.
      if (set === SETS[0]) {
        out[name] = {
          width,
          height,
          cx: Number((m.cx * shrink).toFixed(2)),
          cy: Number((m.cy * shrink).toFixed(2)),
          major: Number((m.major * shrink).toFixed(2)),
          minor: Number((m.minor * shrink).toFixed(2)),
          // Scale-free, so it survives the resolution cap untouched.
          angle: Number(m.angle.toFixed(4)),
        }
      }
    }
    const built = out[name]
    console.log(
      `  ${name.padEnd(20)} ${String(built.width).padStart(4)}x${String(built.height).padStart(4)}` +
        `  centroid ${m.cx.toFixed(0).padStart(4)},${m.cy.toFixed(0).padStart(4)}` +
        `  axes ${m.major.toFixed(0)}x${m.minor.toFixed(0)}` +
        `  at ${((m.angle * 180) / Math.PI).toFixed(0).padStart(4)}deg` +
        note
    )
  }

  await writeFile(
    path.join(root, 'src', 'sprite-data.json'),
    JSON.stringify({ poseCount: POSES, flavours, sprites: out }, null, 2) + '\n',
    'utf8'
  )
  console.log(`sprites: built ${sources.length} across ${flavours.length} flavour(s)`)
}

/**
 * The empty kitchen everything else is composited over.
 *
 * Built from the best version of the plate that exists, in this order:
 *
 *   portrait-src/plate-tall.png     extended top and bottom for phone screens
 *   oven-src/plate-flameless.png    the fire taken out, ready to be animated
 *   sprites-src/plate.png           the original
 *
 * Each is produced from the one below it by a prepare- script of its own, and
 * each is optional - the site runs off the original with a still fire in a
 * letterboxed frame, which is what it did before either existed. src/prop-data
 * .json carries the geometry that goes with whichever one was used.
 */
async function buildPlate() {
  const src = await pickSource([
    { dir: path.join(root, 'portrait-src'), base: 'plate-tall' },
    { dir: path.join(root, 'oven-src'), base: 'plate-flameless' },
    { dir: spriteSrc, base: 'plate' },
  ])
  if (!src) throw new Error('no plate source found')

  const dest = path.join(publicDir, 'plate.webp')
  if (await isFresh(src, dest)) {
    console.log('plate: up to date')
    return
  }
  const { width, height } = await sharp(src).metadata()
  await mkdir(publicDir, { recursive: true })
  // The plate is one big photographic image and by far the largest single
  // download, so it is encoded a little harder than the sprites. It is also
  // behind everything else and mostly out of focus, which is exactly the kind
  // of picture WebP loses least on.
  await sharp(src).webp({ quality: 80, effort: 6 }).toFile(dest)
  console.log(`plate: built ${width}x${height} from ${path.relative(root, src)}`)
}

/**
 * Crops the lockup out of the brand sheet and turns the flat cream backdrop
 * transparent.
 *
 * The key is a flood fill seeded from the border rather than a global colour
 * match, because the melted cheese in the mark is nearly the same cream as the
 * sheet background - a global match would punch holes straight through it. The
 * fill can only reach pixels connected to the edge, and the mark's dark outline
 * seals the cheese off from that.
 */
async function buildLogo() {
  const src = await requireSource(root, 'logo', root)
  const dest = path.join(publicDir, 'logo.webp')
  if (await isFresh(src, dest)) {
    console.log('logo: up to date')
    return
  }

  const { data, info } = await sharp(src)
    .extract(LOGO_CROP)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width: w, height: h } = info
  const bg = [data[0], data[1], data[2]]
  const distSq = (i) => {
    const o = i * 4
    const dr = data[o] - bg[0]
    const dg = data[o + 1] - bg[1]
    const db = data[o + 2] - bg[2]
    return dr * dr + dg * dg + db * db
  }

  const outside = new Uint8Array(w * h)
  const stack = []
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)

  const tolSq = KEY_TOLERANCE * KEY_TOLERANCE
  while (stack.length) {
    const i = stack.pop()
    if (outside[i] || distSq(i) > tolSq) continue
    outside[i] = 1
    const x = i % w
    const y = (i - x) / w
    if (x > 0) stack.push(i - 1)
    if (x < w - 1) stack.push(i + 1)
    if (y > 0) stack.push(i - w)
    if (y < h - 1) stack.push(i + w)
  }

  const featherSq = KEY_FEATHER * KEY_FEATHER
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (outside[i]) {
        data[i * 4 + 3] = 0
        continue
      }
      const touchesKey =
        (x > 0 && outside[i - 1]) ||
        (x < w - 1 && outside[i + 1]) ||
        (y > 0 && outside[i - w]) ||
        (y < h - 1 && outside[i + w])
      if (touchesKey) {
        const d = distSq(i)
        if (d < featherSq) {
          const t = (Math.sqrt(d) - KEY_TOLERANCE) / (KEY_FEATHER - KEY_TOLERANCE)
          data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, t)) * 255)
        }
      }
      if (data[i * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) throw new Error('logo: keying removed the entire image')

  await mkdir(publicDir, { recursive: true })
  await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .resize({ width: LOGO_WIDTH, withoutEnlargement: true })
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(dest)

  console.log(`logo: built ${maxX - minX + 1}x${maxY - minY + 1} -> ${LOGO_WIDTH}px wide`)
}

await buildSprites()
await buildPlate()
await buildLogo()
