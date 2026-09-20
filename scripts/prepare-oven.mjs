/**
 * Turns what gen-oven.mjs generated into the two things the runtime needs.
 *
 *   oven-src/embers.png    ->  oven-src/plate-flameless.png
 *   oven-src/flame-NN.png  ->  public/fire/flame-NN.webp  + src/prop-data.json
 *
 * Sources are only ever read.
 *
 * **The plate** has a fire painted into it. Animated flames drawn over painted
 * ones read as two fires, so the cavity is replaced with the flameless render -
 * but only the cavity. The brick arch around it is original pixels, because
 * regenerating the whole crop would re-imagine the bricks and make the oven
 * crawl. The two are joined through an arch-shaped mask that is eroded and
 * feathered, and the generated crop is nudged into alignment first by matching
 * the brick *around* the hole it is filling.
 *
 * **The flames** are keyed off magenta with a ramp rather than a threshold.
 * A hard key is right for a pizza, which has a definite edge; fire does not
 * have one, and cutting it out with a threshold leaves a flame with a crisp
 * outline, which is the one thing fire never has. What survives is drawn with
 * `lighter`, so the sprite's own alpha is its brightness.
 *
 * Frames come out ordered into a breathing cycle, not in the order generated:
 * sorted by how much flame there is and then walked up and back down, so
 * consecutive frames are always neighbours in size and the loop has no seam.
 */
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { pickSource, requireSource } from './sources.mjs'
import { CAVITY, CONTEXT, FIRE_RECT } from './geometry.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ovenSrc = path.join(root, 'oven-src')
const fireOut = path.join(root, 'public', 'fire')
const spriteSrc = path.join(root, 'sprites-src')
const platePatched = path.join(ovenSrc, 'plate-flameless.png')
const propData = path.join(root, 'src', 'prop-data.json')

/** Output size of one flame frame, in pixels. 2x the rect, for a 4K display. */
const FRAME = { width: 560, height: 304 }

/** Distance from the background colour at which a pixel is fully opaque. */
const KEY_LO = 58
const KEY_HI = 132

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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// ----------------------------------------------------------------- flames ---

/**
 * Lifts the magenta off a flame and leaves its softness intact.
 *
 * The background colour is taken from the border rather than assumed to be
 * #FF00FF, so a generation that drifts a few points still keys. Alpha ramps
 * between KEY_LO and KEY_HI from that colour, which is what gives a flame back
 * its glow instead of a cut edge.
 */
function keyFlame(img) {
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

  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const dr = data[o] - bg[0]
    const dg = data[o + 1] - bg[1]
    const db = data[o + 2] - bg[2]
    const d = Math.sqrt(dr * dr + dg * dg + db * db)
    const a = smoothstep(KEY_LO, KEY_HI, d)

    if (a <= 0) {
      // Bled to black, not to a mean colour: these pixels are composited
      // additively, and black is the value that adds nothing. WebP smearing a
      // little of it past the flame edge then costs nothing at all.
      data[o] = data[o + 1] = data[o + 2] = 0
      data[o + 3] = 0
      continue
    }

    // Despill. Magenta pushes blue up; fire has almost none, so clamping blue
    // to green removes the spill without touching the flame's own colour.
    if (data[o + 2] > data[o + 1]) data[o + 2] = data[o + 1]
    data[o + 3] = Math.round(a * 255)
  }
  return img
}

/** Alpha bounding box, plus how much flame there is inside it. */
function measureFlame({ data, width: w, height: h }) {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  let mass = 0
  let lum = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const a = data[o + 3]
      if (a < 12) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      mass += a / 255
      lum += ((data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11) / 255) * (a / 255)
    }
  }
  if (x1 < 0) return null
  return {
    trim: { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
    mass,
    /** Total light this frame throws - what the room's flicker follows. */
    energy: lum,
  }
}

async function buildFlames() {
  const files = (await readdir(ovenSrc))
    .filter((f) => /^flame-\d+\.(?:png|webp)$/.test(f))
    .sort()
  if (!files.length) {
    console.log('fire: no flame sources yet')
    return null
  }

  await mkdir(fireOut, { recursive: true })

  const built = []
  for (const f of files) {
    const img = keyFlame(await loadRGBA(path.join(ovenSrc, f)))
    const m = measureFlame(img)
    if (!m) {
      console.warn(`  ! ${f}: keyed to nothing, skipped`)
      continue
    }

    // Standing on the bottom edge of a fixed frame, scaled by height so every
    // flame is the same fire seen a moment apart rather than a fire that
    // changes size ten times a second. Width is capped for the wide ones.
    const byHeight = (FRAME.height * 0.94) / m.trim.height
    const byWidth = (FRAME.width * 0.96) / m.trim.width
    const scale = Math.min(byHeight, byWidth)
    const dw = Math.max(1, Math.round(m.trim.width * scale))
    const dh = Math.max(1, Math.round(m.trim.height * scale))

    const flame = await sharp(img.data, {
      raw: { width: img.width, height: img.height, channels: 4 },
    })
      .extract(m.trim)
      .resize(dw, dh)
      .png()
      .toBuffer()

    const canvas = await sharp({
      create: {
        width: FRAME.width,
        height: FRAME.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: flame,
          left: Math.round((FRAME.width - dw) / 2),
          top: FRAME.height - dh,
        },
      ])
      .png()
      .toBuffer()

    built.push({ file: f, buffer: canvas, mass: m.mass * scale * scale, energy: m.energy * scale * scale })
    console.log(`  ${f.padEnd(14)} ${m.trim.width}x${m.trim.height} -> ${dw}x${dh}`)
  }

  if (!built.length) return null

  // Up the size order and back down: consecutive frames are then always
  // neighbours in size, and the last frame leads back into the first with no
  // jump. An unsorted cycle flickers between a wisp and a blaze.
  built.sort((a, b) => a.mass - b.mass)
  const cycle = [...built, ...built.slice(1, -1).reverse()]

  const maxEnergy = Math.max(...cycle.map((c) => c.energy)) || 1
  const brightness = []
  for (let i = 0; i < cycle.length; i++) {
    const dest = path.join(fireOut, `flame-${String(i + 1).padStart(2, '0')}.webp`)
    await sharp(cycle[i].buffer)
      .webp({ quality: 82, alphaQuality: 92, smartSubsample: true })
      .toFile(dest)
    brightness.push(Number((cycle[i].energy / maxEnergy).toFixed(3)))
  }

  console.log(`fire: ${cycle.length} frame(s) from ${built.length} source(s)`)
  return { ...FIRE_RECT, frames: cycle.length, brightness }
}

// ------------------------------------------------------------------ plate ---

/**
 * Nudges the generated crop onto the original.
 *
 * Only the bricks are compared - the whole point of the generation is that the
 * cavity is different, so matching on it would align the fire that is no
 * longer there. A few pixels of slide is normal; Gemini reframes slightly even
 * when told not to.
 */
function bestOffset(orig, gen, mask, w, h, range = 14) {
  let best = { dx: 0, dy: 0, err: Infinity }
  for (let dy = -range; dy <= range; dy += 2) {
    for (let dx = -range; dx <= range; dx += 2) {
      let err = 0
      let n = 0
      for (let y = range; y < h - range; y += 3) {
        for (let x = range; x < w - range; x += 3) {
          if (mask[y * w + x]) continue // skip the cavity
          const a = orig[(y * w + x) * 4]
          const o = ((y + dy) * w + (x + dx)) * 4
          const b = gen[o]
          const d = a - b
          err += d * d
          n++
        }
      }
      err /= n || 1
      if (err < best.err) best = { dx, dy, err }
    }
  }
  return best
}

async function buildPlate() {
  const source = await pickSource([
    { dir: ovenSrc, base: 'embers' },
    { dir: ovenSrc, base: 'embers-take2' },
  ])
  const plateSrc = await requireSource(spriteSrc, 'plate', root)
  if (!source) {
    console.log('plate: no embers source yet')
    return false
  }

  const { width: W, height: H } = CONTEXT
  const orig = await sharp(plateSrc).extract(CONTEXT).ensureAlpha().raw().toBuffer()
  const gen = await sharp(source).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer()

  // The cavity, as an ellipse whose top is the arch and whose bottom is the
  // hearth floor, in context-crop coordinates.
  const cx = CAVITY.left + CAVITY.width / 2 - CONTEXT.left
  const cy = CAVITY.top + CAVITY.height - CONTEXT.top
  const rx = CAVITY.width / 2
  const ry = CAVITY.height

  const hard = new Uint8Array(W * H)
  const soft = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const e = Math.hypot((x - cx) / rx, (y - cy) / ry)
      const i = y * W + x
      hard[i] = e < 1.04 ? 1 : 0
      // Eroded and feathered, so the join runs through the dark inside of the
      // oven rather than along the brick edge where any mismatch would show.
      let a = 1 - smoothstep(0.84, 0.99, e)
      if (y > cy) a = 0
      soft[i] = a
    }
  }

  const { dx, dy, err } = bestOffset(orig, gen, hard, W, H)
  console.log(`plate: aligning embers by ${dx},${dy} (residual ${err.toFixed(0)})`)

  const out = Buffer.from(orig)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = soft[y * W + x]
      if (a <= 0) continue
      const sx = Math.min(W - 1, Math.max(0, x + dx))
      const sy = Math.min(H - 1, Math.max(0, y + dy))
      const o = (y * W + x) * 4
      const g = (sy * W + sx) * 4
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(orig[o + c] * (1 - a) + gen[g + c] * a)
    }
  }

  const patch = await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  await sharp(plateSrc)
    .composite([{ input: patch, left: CONTEXT.left, top: CONTEXT.top }])
    .png()
    .toFile(platePatched)
  console.log(`plate: ${path.relative(root, platePatched)}`)
  return true
}

// ------------------------------------------------------------------- main ---

const fire = await buildFlames()
await buildPlate()

if (fire) {
  const data = JSON.parse(await readFile(propData, 'utf8'))
  data.fire = fire
  await writeFile(propData, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log(`prop-data: fire ${fire.frames} frame(s) at ${fire.left},${fire.top}`)
}
