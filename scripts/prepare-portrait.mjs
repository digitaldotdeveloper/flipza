/**
 * Joins the generated extension onto the real kitchen.
 *
 *   portrait-src/portrait      ->  portrait-src/plate-tall.webp
 *   oven-src/plate-flameless (or sprites-src/plate) as the middle
 *                              ->  src/prop-data.json  { plate }
 *
 * Sources are only ever read.
 *
 * Only the new strips come from the generation. The middle is the original
 * plate at full resolution, composited back over the top of it, because the
 * generation came back at about 1024px on its long edge and everything anyone
 * looks at - the oven, the neon, the menu board, the logo - lives there. What
 * is kept is ceiling and counter: low-detail, low-contrast, and none the worse
 * for having been upscaled.
 *
 * Two things make the join invisible:
 *
 *   - the seam is a ramp, not an edge. The original fades into the generated
 *     strip over a band, so there is no line for the eye to catch.
 *   - the strip is levelled to the original first. A generation comes back a
 *     few percent brighter or cooler, which across a flat wall reads as a
 *     band even when the seam itself is perfect. Each strip is corrected by
 *     the ratio measured at the seam, fading out with distance from it.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { pickSource } from './sources.mjs'
import { EXTEND } from './geometry.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const portraitSrc = path.join(root, 'portrait-src')
const propData = path.join(root, 'src', 'prop-data.json')

/** Pixels over which the original fades into the generated strip. */
const SEAM = 46
/** Rows either side of the seam averaged when levelling the strip. */
const LEVEL_ROWS = 10
/** Pixels over which the level correction fades back to none. */
const LEVEL_FALLOFF = 420

async function exists(f) {
  try {
    await stat(f)
    return true
  } catch {
    return false
  }
}

async function pick(...candidates) {
  for (const c of candidates) if (await exists(c)) return c
  return null
}

/** Mean RGB of a horizontal band. */
function bandMean(data, W, y0, rows) {
  const sum = [0, 0, 0]
  let n = 0
  for (let y = y0; y < y0 + rows; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      sum[0] += data[o]
      sum[1] += data[o + 1]
      sum[2] += data[o + 2]
      n++
    }
  }
  return sum.map((v) => v / (n || 1))
}

const base = await pickSource([
  { dir: path.join(root, 'oven-src'), base: 'plate-flameless' },
  { dir: path.join(root, 'sprites-src'), base: 'plate' },
])
const gen = await pickSource([
  { dir: portraitSrc, base: 'portrait' },
  { dir: portraitSrc, base: 'portrait-take2' },
])

if (!gen) {
  console.log('portrait: nothing generated yet - run gen-portrait.mjs')
  process.exit(0)
}

const meta = await sharp(base).metadata()
const W = meta.width
const MID = meta.height
const H = MID + EXTEND.top + EXTEND.bottom

const out = await sharp(gen).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer()
const mid = await sharp(base).ensureAlpha().raw().toBuffer()

// ------------------------------------------------------------- levelling ---

// Measured just inside each seam, on both images, and applied as a gain that
// fades out away from the seam - so the strip matches the original where they
// touch and is left alone further off, where nothing is there to compare it to.
const topOriginal = bandMean(mid, W, 0, LEVEL_ROWS)
const topGenerated = bandMean(out, W, EXTEND.top, LEVEL_ROWS)
const botOriginal = bandMean(mid, W, MID - LEVEL_ROWS, LEVEL_ROWS)
const botGenerated = bandMean(out, W, EXTEND.top + MID - LEVEL_ROWS, LEVEL_ROWS)

const gain = (a, b) => a.map((v, i) => (b[i] > 4 ? Math.min(1.6, Math.max(0.62, v / b[i])) : 1))
const topGain = gain(topOriginal, topGenerated)
const botGain = gain(botOriginal, botGenerated)
console.log(
  `portrait: levelling top x${topGain.map((g) => g.toFixed(2)).join('/')} ` +
    `bottom x${botGain.map((g) => g.toFixed(2)).join('/')}`
)

for (let y = 0; y < H; y++) {
  let g = null
  let fade = 0
  if (y < EXTEND.top) {
    g = topGain
    fade = Math.max(0, 1 - (EXTEND.top - y) / LEVEL_FALLOFF)
  } else if (y >= EXTEND.top + MID) {
    g = botGain
    fade = Math.max(0, 1 - (y - (EXTEND.top + MID)) / LEVEL_FALLOFF)
  }
  if (!g) continue
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4
    for (let c = 0; c < 3; c++) {
      const corrected = out[o + c] * (1 + (g[c] - 1) * fade)
      out[o + c] = corrected > 255 ? 255 : corrected < 0 ? 0 : Math.round(corrected)
    }
  }
}

// ----------------------------------------------------------------- seams ---

for (let y = 0; y < MID; y++) {
  // 1 in the middle of the original, ramping to 0 at each of its own edges.
  let a = 1
  if (y < SEAM) a = y / SEAM
  else if (y > MID - 1 - SEAM) a = (MID - 1 - y) / SEAM
  const dy = y + EXTEND.top
  for (let x = 0; x < W; x++) {
    const o = (dy * W + x) * 4
    const m = (y * W + x) * 4
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(out[o + c] * (1 - a) + mid[m + c] * a)
  }
}

await mkdir(portraitSrc, { recursive: true })
// Lossless WebP for the same reason prepare-oven writes one: an intermediate
// that exists in two formats is an intermediate that goes stale.
const dest = path.join(portraitSrc, 'plate-tall.webp')
await sharp(out, { raw: { width: W, height: H, channels: 4 } })
  .removeAlpha()
  .webp({ lossless: true, effort: 4 })
  .toFile(dest)
console.log(`portrait: ${W}x${H} -> ${path.relative(root, dest)} (middle from ${path.basename(base)})`)

const data = JSON.parse(await readFile(propData, 'utf8'))
data.plate = { width: W, height: H, left: 0, top: EXTEND.top }
await writeFile(propData, JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log(`prop-data: plate ${W}x${H}, scene origin at 0,${EXTEND.top}`)
