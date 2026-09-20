/**
 * Extends the kitchen vertically, so the scene can fill a phone screen.
 *
 *   node scripts/gen-portrait.mjs        # two takes
 *
 * Writes portrait-src/. Sources are only ever read.
 *
 * The plate is 1672x941, which is 16:9. A phone is nearer 9:19.5, so covering
 * one with it crops about three quarters of its width - the pizza is 500 plate
 * pixels across and only ~435 of them would be on screen, so the pizza itself
 * would be cut off at both sides. Zooming out does not help: the further out
 * the scene is fitted, the *more* plate height the screen needs, because the
 * window is a fixed shape. The only real fix is more picture above and below.
 *
 * It is an outpaint rather than a new render for the obvious reason: the
 * kitchen carries the branding, the menu board, the neon sign and the oven that
 * every sprite was lit to match. A second generated kitchen would be a
 * different restaurant.
 *
 * What is generated is thrown away except for the new strips - prepare-portrait
 * composites the original pixels back over the middle at full resolution, so
 * the part of the scene anyone actually looks at is never re-encoded through a
 * 1024px generation.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { requireSource } from './sources.mjs'
import { runBatch, upload } from './studio.mjs'
import { EXTEND } from './geometry.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'portrait-src')
const spriteSrc = path.join(root, 'sprites-src')

/**
 * The generator is shown the original sitting in the taller frame with the new
 * areas roughly filled in by stretching the edge rows - a blank margin invites
 * it to reframe the photograph instead of continuing it, while something
 * already the right colour reads as an image to finish.
 */
async function buildInput(dest) {
  const plateSrc = await requireSource(spriteSrc, 'plate', root)
  const { width, height } = await sharp(plateSrc).metadata()
  const W = width
  const H = height + EXTEND.top + EXTEND.bottom

  const topFill = await sharp(plateSrc)
    .extract({ left: 0, top: 0, width, height: 6 })
    .resize(W, EXTEND.top, { fit: 'fill' })
    .blur(18)
    .png()
    .toBuffer()

  const bottomFill = await sharp(plateSrc)
    .extract({ left: 0, top: height - 6, width, height: 6 })
    .resize(W, EXTEND.bottom, { fit: 'fill' })
    .blur(18)
    .png()
    .toBuffer()

  await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 18, g: 16, b: 15 } },
  })
    .composite([
      { input: topFill, left: 0, top: 0 },
      { input: await sharp(plateSrc).png().toBuffer(), left: 0, top: EXTEND.top },
      { input: bottomFill, left: 0, top: EXTEND.top + height },
    ])
    .png()
    .toFile(dest)

  return { W, H }
}

const prompt = [
  'This is a photograph of a pizzeria kitchen that has been placed in a taller',
  'frame. The middle of it is the real photograph. The blurred band along the',
  'top and the blurred band along the bottom are empty space to be filled in.',
  '',
  'Extend the photograph into those two bands so that it becomes one single',
  'taller photograph of the same room, shot with a wider lens.',
  '',
  'Above: continue the wall upward and show the ceiling of the kitchen - warm',
  'downlights, the cord of the hanging lamp on the left continuing up to it, the',
  'tops of the shelves. Keep it darker than the middle of the picture, the way a',
  'ceiling above warm counter lighting is.',
  '',
  'Below: continue the stone counter forward toward the camera, the same',
  'speckled stone with the same soft reflections of the oven light on it.',
  '',
  'The middle of the image - the oven, the fire, the counter, the menu board,',
  'the neon sign, the stacked pizza boxes and the logo on the wall - must stay',
  'EXACTLY as it is. Do not move it, do not rescale it, do not relight it and do',
  'not change one thing in it. Only fill in the two empty bands, matching the',
  'perspective, the warmth and the grain of the photograph exactly, so the joins',
  'are invisible.',
].join('\n')

await mkdir(outDir, { recursive: true })
const inputFile = path.join(outDir, '_input.png')
const { W, H } = await buildInput(inputFile)
console.log(`portrait: input ${W}x${H} -> ${path.relative(root, inputFile)}`)

const attach = [await upload(inputFile)]
await runBatch([{ name: 'portrait', prompt, attach, runs: 2 }], (name, run) =>
  path.join(outDir, run > 0 ? `${name}-take${run + 1}.png` : `${name}.png`)
)
