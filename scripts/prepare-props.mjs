/**
 * Cuts what gen-props.mjs generated into runtime sprites.
 *
 *   props-src/topping-<id>.png  ->  public/toppings/<id>-NN.webp
 *   props-src/box-*             ->  public/props/box-NN.webp (lid up -> shut)
 *   props-src/side-*            ->  public/props/side-*.webp
 *                               ->  src/prop-data.json
 *
 * Sources are only ever read.
 *
 * A topping sheet is one image of a dozen separated pieces, and every piece is
 * cut out of it individually by connected component. That is the whole reason
 * the sheet was asked for that way: twelve pieces from one generation are
 * twelve *different* olives, and a rain of twelve identical olives reads as a
 * pattern rather than as food. The pieces are then normalised to a sensible
 * size on the pizza, because Gemini's idea of scale varies between sheets and
 * an olive the size of the pizza is not a topping.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { findSource } from './sources.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const propsSrc = path.join(root, 'props-src')
const toppingOut = path.join(root, 'public', 'toppings')
const propOut = path.join(root, 'public', 'props')
const propData = path.join(root, 'src', 'prop-data.json')

/** Colour distance from the sampled background at which a pixel is kept. */
const TOLERANCE = 74
/** Rings of spill-contaminated pixels discarded inwards from the keyed area. */
const ERODE = 3
/** Rings past the erosion faded out, so the new edge is not hard. */
const SOFT = 2

/**
 * How big each extra should be on the pizza, in plate pixels, measured on its
 * longest side. The pizza is 500 plate pixels across, so a 40px olive covers
 * about a twelfth of it - which is what an olive does.
 */
const PIECE_SIZE = { cheese: 62, olives: 38, chilli: 40, basil: 58 }
const DEFAULT_PIECE = 48

/**
 * Pieces are stored at twice their plate size so they stay sharp when the
 * plate is scaled up on a big display, and the renderer halves them again.
 */
const PIECE_OVERSAMPLE = 2

/** A component smaller than this share of the biggest one is a speck. */
const MIN_SHARE = 0.06

async function exists(f) {
  try {
    await stat(f)
    return true
  } catch {
    return false
  }
}

async function loadRGBA(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * Lifts a flat chroma background, in place.
 *
 * A global colour match, not the flood fill from the border that the pizza
 * sprites use - and the difference matters here. An olive ring has a hole in
 * the middle of it, and that hole is background the fill can never walk to, so
 * a flood fill leaves every olive with a magenta centre. Matching on colour
 * instead punches the holes out, which is what a hole is.
 *
 * It is safe for these sheets in a way it would not be for the brand sheet:
 * the nearest thing to magenta on any of them is the red of the logo, which is
 * three times the tolerance away. The background colour is still sampled from
 * the border rather than assumed, so a generation that drifts off #FF00FF
 * still keys.
 */
function key(img) {
  const { data, width: w, height: h } = img

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

  const tolSq = TOLERANCE * TOLERANCE
  const outside = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) if (distSq(i) <= tolSq) outside[i] = 1

  // Grow the keyed area inwards. The ring of pixels just inside the edge
  // carries chroma spill, and there is no clean colour to recover in them -
  // throwing them away is cheaper and looks better than trying.
  let front = outside
  for (let r = 0; r < ERODE + SOFT; r++) {
    const next = Uint8Array.from(front)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (front[i]) continue
        if (
          (x > 0 && front[i - 1]) ||
          (x < w - 1 && front[i + 1]) ||
          (y > 0 && front[i - w]) ||
          (y < h - 1 && front[i + w])
        ) {
          next[i] = r < ERODE ? 1 : 2 + r - ERODE
        }
      }
    }
    front = next
  }

  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const v = front[i]
    if (v === 1) {
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0
    } else if (v > 1) {
      data[o + 3] = Math.round((255 * (v - 1)) / (SOFT + 1))
    }
    // Despill.
    //
    // Magenta lifts red and blue *together*, which is what separates spill
    // from anything that is genuinely red: a chilli or a red carton has its
    // blue down near its green, while a white cup with magenta bouncing off it
    // has both above. So a pixel with red and blue both above green is spill,
    // and both are pulled back towards it. Clamping blue alone - which is what
    // this did at first - turns the spill from pink to red and leaves it just
    // as visible.
    if (data[o + 3]) {
      const r = data[o]
      const g = data[o + 1]
      const b = data[o + 2]
      if (r > g + 18 && b > g + 18) {
        const cut = Math.min(Math.min(r, b) - g, 90)
        data[o] = r - cut
        data[o + 2] = b - cut
      }
    }
  }
  return img
}

/** Every separate island of opaque pixels, largest first. */
function components({ data, width: w, height: h }) {
  const seen = new Uint8Array(w * h)
  const found = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || data[start * 4 + 3] < 40) continue
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    let area = 0
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()
      const x = i % w
      const y = (i / w) | 0
      area++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      const push = (j) => {
        if (j >= 0 && j < w * h && !seen[j] && data[j * 4 + 3] >= 40) {
          seen[j] = 1
          stack.push(j)
        }
      }
      if (x > 0) push(i - 1)
      if (x < w - 1) push(i + 1)
      if (y > 0) push(i - w)
      if (y < h - 1) push(i + w)
    }
    found.push({ area, trim: { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } })
  }
  return found.sort((a, b) => b.area - a.area)
}

// -------------------------------------------------------------- toppings ---

async function buildToppings(counts) {
  await mkdir(toppingOut, { recursive: true })
  for (const id of Object.keys(PIECE_SIZE)) {
    const src = await findSource(propsSrc, `topping-${id}`)
    if (!src) {
      console.log(`  ${id}: no sheet yet`)
      continue
    }

    const img = key(await loadRGBA(src))
    const parts = components(img)
    if (!parts.length) {
      console.warn(`  ! ${id}: keyed to nothing`)
      continue
    }

    // Anything much smaller than the biggest piece is a crumb the generator
    // sprinkled in, or a speck the key left behind. Neither is a topping.
    const floor = parts[0].area * MIN_SHARE
    const keep = parts.filter((p) => p.area >= floor).slice(0, 14)

    const target = (PIECE_SIZE[id] ?? DEFAULT_PIECE) * PIECE_OVERSAMPLE
    let n = 0
    for (const p of keep) {
      const long = Math.max(p.trim.width, p.trim.height)
      const scale = target / long
      const dest = path.join(toppingOut, `${id}-${String(++n).padStart(2, '0')}.webp`)
      await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
        .extract(p.trim)
        .resize(Math.max(1, Math.round(p.trim.width * scale)), Math.max(1, Math.round(p.trim.height * scale)))
        .webp({ quality: 86, alphaQuality: 100 })
        .toFile(dest)
    }
    counts[id] = n
    console.log(`  ${id.padEnd(8)} ${parts.length} island(s) -> ${n} piece(s) at ${target}px`)
  }
}

// ------------------------------------------------------------------- box ---

/**
 * Two frames: lid up, and lid shut.
 *
 * Not for want of trying to get the in-between ones. Two batches asked for the
 * lid at a quarter, a third, a half and three quarters of the way down, and
 * what came back was the same lid standing up, or leaning off to one side -
 * from this camera a lid rotating about a hinge at the back mostly
 * *foreshortens* rather than sweeping, and that is apparently a hard thing to
 * ask for. So the in-between is computed instead: the renderer splits this
 * frame at the hinge and squashes the lid towards it, which is exactly what
 * the projection of a rotating lid does, and is controllable to the frame.
 */
const BOX_SEQUENCE = ['box-open', 'box-closed']

/** Rows at the bottom of a box used to find the base, as a share of height. */
const BASE_BAND = 0.16

/** Where in the sprite to look for the lid/base boundary. */
const HINGE_BAND = [0.3, 0.85]

/** The row where the silhouette suddenly widens: the top of the base. */
function findHinge({ data, width: w }, trim) {
  const widths = []
  for (let y = trim.top; y < trim.top + trim.height; y++) {
    let x0 = w
    let x1 = -1
    for (let x = trim.left; x < trim.left + trim.width; x++) {
      if (data[(y * w + x) * 4 + 3] < 40) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
    }
    widths.push(x1 < 0 ? 0 : x1 - x0 + 1)
  }
  let bestRow = Math.round(widths.length * 0.62)
  let bestJump = 0
  const from = Math.round(widths.length * HINGE_BAND[0])
  const to = Math.round(widths.length * HINGE_BAND[1])
  for (let y = from; y < to - 1; y++) {
    const jump = widths[y + 1] - widths[y]
    if (jump > bestJump) {
      bestJump = jump
      bestRow = y + 1
    }
  }
  return Number((bestRow / widths.length).toFixed(4))
}

/**
 * Where a box's base sits: the horizontal centre of its bottom band.
 *
 * Not the centroid of the whole sprite, which is the thing that must NOT be
 * used: an open lid leans back and drags the centroid with it, so registering
 * on the centroid would slide the base sideways as the lid comes down - the
 * exact motion the sequence exists to avoid. The bottom of the box is the part
 * that stays still in life, so it is the part aligned here.
 */
function baseAnchor({ data, width: w }, trim) {
  const from = trim.top + Math.round(trim.height * (1 - BASE_BAND))
  let x0 = w
  let x1 = -1
  for (let y = from; y < trim.top + trim.height; y++) {
    for (let x = trim.left; x < trim.left + trim.width; x++) {
      if (data[(y * w + x) * 4 + 3] < 40) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
    }
  }
  if (x1 < 0) return { x: trim.left + trim.width / 2, base: 0 }
  return { x: (x0 + x1) / 2, base: x1 - x0 + 1 }
}

/**
 * Cuts the box sequence and registers every frame on its base.
 *
 * All frames come out the same size and symmetric about the base's centre, so
 * the renderer can draw any of them into one rectangle and nothing but the lid
 * moves between them.
 */
async function buildBox(box) {
  await mkdir(propOut, { recursive: true })

  const frames = []
  for (const name of BOX_SEQUENCE) {
    const src = await findSource(propsSrc, name)
    if (!src) {
      console.log(`  ${name}: not generated yet`)
      continue
    }
    const img = key(await loadRGBA(src))
    const parts = components(img)
    if (!parts.length) {
      console.warn(`  ! ${name}: keyed to nothing`)
      continue
    }
    // The box is one object; anything else in frame is a stray the key left.
    const trim = parts[0].trim
    frames.push({ name, img, trim, anchor: baseAnchor(img, trim) })
  }

  if (!frames.length) return

  // Where the lid meets the base, as a fraction of the sprite's height.
  //
  // Found from the width profile rather than guessed: the lid stands roughly
  // straight up, so its width barely changes down its length, while the base
  // widens steadily towards the camera. The boundary is the one row where the
  // width jumps, and it is unmistakable - 508px to 550px from one row to the
  // next on this art.
  box.hinge = findHinge(frames[0].img, frames[0].trim)

  // Every frame is scaled so its base comes out the same width.
  //
  // Registering the base's *position* is not enough on its own: these are
  // separate photographs, and one that came back a few per cent larger makes
  // the whole box jump size at that frame. The base is the one part that is
  // the same object in every shot, so matching its width matches the scale.
  // The first frame - the open box every other one was generated from - is
  // what they are all matched to.
  const refBase = frames[0].anchor.base || 1
  for (const f of frames) {
    f.k = f.anchor.base ? refBase / f.anchor.base : 1
    f.w = Math.max(1, Math.round(f.trim.width * f.k))
    f.h = Math.max(1, Math.round(f.trim.height * f.k))
    f.ax = (f.anchor.x - f.trim.left) * f.k
  }

  // One canvas that fits every frame, with the base centre exactly in the
  // middle of it - so the renderer centring the bitmap centres the base.
  let half = 0
  let tall = 0
  for (const f of frames) {
    half = Math.max(half, f.ax, f.w - f.ax)
    tall = Math.max(tall, f.h)
  }
  const W = Math.ceil(half * 2)
  const H = Math.ceil(tall)

  let n = 0
  for (const f of frames) {
    let pipeline = sharp(f.img.data, {
      raw: { width: f.img.width, height: f.img.height, channels: 4 },
    }).extract(f.trim)
    if (f.k !== 1) pipeline = pipeline.resize(f.w, f.h)
    const piece = await pipeline.png().toBuffer()

    const dest = path.join(propOut, `box-${String(++n).padStart(2, '0')}.webp`)
    await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: piece, left: Math.round(W / 2 - f.ax), top: H - f.h }])
      .webp({ quality: 88, alphaQuality: 100 })
      .toFile(dest)
    console.log(
      `  ${f.name.padEnd(12)} ${f.trim.width}x${f.trim.height}` +
        `  base ${f.anchor.base}px  x${f.k.toFixed(3)} -> box-${String(n).padStart(2, '0')}`
    )
  }

  box.frames = n
  console.log(`  box: ${n} frame(s) registered into ${W}x${H}, hinge at ${box.hinge}`)
}

// ----------------------------------------------------------------- sides ---

/** Tallest a side is stored at - twice the size it is ever drawn. */
const SIDE_HEIGHT = 380

async function buildSides(sides) {
  await mkdir(propOut, { recursive: true })
  for (const which of ['fries', 'cola']) {
    const src = await findSource(propsSrc, `side-${which}`)
    if (!src) {
      console.log(`  side-${which}: not generated yet`)
      continue
    }
    const img = key(await loadRGBA(src))
    const parts = components(img)
    if (!parts.length) {
      console.warn(`  ! side-${which}: keyed to nothing`)
      continue
    }
    const trim = parts[0].trim
    const k = SIDE_HEIGHT / trim.height
    await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
      .extract(trim)
      .resize(Math.max(1, Math.round(trim.width * k)), SIDE_HEIGHT)
      .webp({ quality: 88, alphaQuality: 100 })
      .toFile(path.join(propOut, `side-${which}.webp`))
    sides[which] = true
    console.log(`  side-${which}: ${trim.width}x${trim.height}`)
  }
}

// ------------------------------------------------------------------ main ---

const data = JSON.parse(await readFile(propData, 'utf8'))
const counts = { ...data.toppings }
const box = { frames: 0, hinge: 0.62 }
const sides = { fries: false, cola: false }

console.log('toppings:')
await buildToppings(counts)
console.log('box:')
await buildBox(box)
console.log('sides:')
await buildSides(sides)

data.toppings = counts
data.box = box
data.sides = sides
await writeFile(propData, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log('prop-data: updated')
