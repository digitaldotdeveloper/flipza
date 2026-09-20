/**
 * Cuts what gen-props.mjs generated into runtime sprites.
 *
 *   props-src/topping-<id>.png  ->  public/toppings/<id>-NN.webp
 *   props-src/box-open.png      ->  public/props/box-open.webp
 *   props-src/box-mid.png       ->  public/props/box-mid.webp
 *   props-src/box-closed.png    ->  public/props/box-closed.webp
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
    // Despill: magenta pushes blue, and almost nothing on a pizza is blue.
    if (data[o + 3] && data[o + 2] > data[o + 1] + 12) {
      data[o + 2] = data[o + 1] + 12
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

async function buildBox(flags) {
  await mkdir(propOut, { recursive: true })
  // Three states, not two. The second take of the closed box came back with
  // the lid halfway down, which is worth more than another closed one: a lid
  // that dissolves open -> half -> shut reads as a lid coming down, where a
  // straight open -> shut reads as one box replacing another.
  for (const which of ['open', 'mid', 'closed']) {
    const src = await findSource(propsSrc, `box-${which}`)
    if (!src) {
      console.log(`  box-${which}: not generated yet`)
      continue
    }
    const img = key(await loadRGBA(src))
    const parts = components(img)
    if (!parts.length) {
      console.warn(`  ! box-${which}: keyed to nothing`)
      continue
    }
    // The box is one object; anything else in frame is a stray the key left.
    const dest = path.join(propOut, `box-${which}.webp`)
    await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
      .extract(parts[0].trim)
      .webp({ quality: 88, alphaQuality: 100 })
      .toFile(dest)
    flags[which] = true
    console.log(`  box-${which}: ${parts[0].trim.width}x${parts[0].trim.height}`)
  }
}

// ------------------------------------------------------------------ main ---

const data = JSON.parse(await readFile(propData, 'utf8'))
const counts = { ...data.toppings }
const flags = { ...data.box }

console.log('toppings:')
await buildToppings(counts)
console.log('box:')
await buildBox(flags)

data.toppings = counts
data.box = flags
await writeFile(propData, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log('prop-data: updated')
