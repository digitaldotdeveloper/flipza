/**
 * Generates the props the ordering flow needs, through the local Gemini Studio
 * dashboard.
 *
 *   node scripts/gen-props.mjs toppings      # the four extras, as sheets
 *   node scripts/gen-props.mjs box           # an open Flipza box
 *   node scripts/gen-props.mjs box-closed    # the same box with its lid down
 *
 * Writes into props-src/. Sources are only ever read.
 *
 * **Toppings** come back as one sheet per extra with the pieces laid out well
 * apart, and prepare-props.mjs cuts them into individual pieces by connected
 * component. One generation therefore yields a dozen distinct olives rather
 * than a dozen copies of one olive, which is what the rain needs: identical
 * pieces falling together read as a texture, not as food.
 *
 * **The box** is generated in two passes, open first and then closed *from the
 * open one as reference*, because the add-to-order moment cross-dissolves
 * between them. Two independent generations of "a Flipza box" come back as two
 * different boxes, and the dissolve then reads as one box turning into another.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { requireSource } from './sources.mjs'
import { runBatch, upload } from './studio.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const propsSrc = path.join(root, 'props-src')

const CHROMA = '#FF00FF'

/** The primary lockup inside the brand sheet - same crop prepare-assets uses. */
const LOGO_CROP = { left: 236, top: 120, width: 800, height: 720 }

const background = [
  `The background must be flat, uniform, solid ${CHROMA} magenta - one single`,
  'colour, with no gradient, no shading, no checkerboard, no pattern and no',
  'shadow cast onto it. Nothing else may appear in the frame: no plate, no',
  'board, no table, no hands, no text and no watermark.',
].join('\n')

// -------------------------------------------------------------- toppings ---

const TOPPINGS = {
  cheese: 'torn pieces of fresh white mozzarella, soft and slightly glossy',
  olives: 'rings of black olive, cut across so each one is a ring',
  chilli: 'thin rings of fresh red chilli, each with its pale seeds showing',
  basil: 'single fresh basil leaves, deep green, each leaf whole and flat',
}

const toppingPrompt = (what) =>
  [
    `A photograph of ${what}, shot from directly overhead in warm, soft light,`,
    'the same warmth as a pizza under a wood-fired oven.',
    '',
    'Lay exactly twelve pieces out in a loose grid across the frame. Every piece',
    'must be completely separate from every other one, with a clear wide gap of',
    'plain background all the way around it - none touching, none overlapping,',
    'none even close. Each piece should be a slightly different shape and turned',
    'a different way, as real pieces are.',
    '',
    'Each piece must be sharp, fully in focus, and photographed flat-on from',
    'above so it reads as itself and not as a shape at an angle.',
    '',
    background,
  ].join('\n')

// ------------------------------------------------------------------- box ---

const boxOpenPrompt = [
  'A photograph of an open, empty pizza delivery box made of clean white',
  'cardboard, sitting level as if on a counter.',
  '',
  'The lid is fully open and tilted back away from the camera, standing up',
  'behind the base, so the empty inside of the box faces the camera. The box is',
  'seen from the front at a slight downward angle, about twenty degrees above',
  'the level of the counter - the same eye level as someone standing at a pizza',
  'counter looking down at a box in front of them.',
  '',
  'The logo on the attached image is printed large and centred on the outside',
  'of the lid, so it faces the camera. Reproduce that logo exactly as it is:',
  'the same wordmark, the same lettering, the same colours, the same pizza slice',
  'mark. Do not redraw or restyle it and do not add any other text.',
  '',
  'Warm indoor lighting from the front, the way a lit pizza counter lights a box.',
  'The box must be sharp and fully in focus, and large in the frame.',
  '',
  background,
].join('\n')

const boxClosedPrompt = [
  'This is a photograph of an open pizza box.',
  '',
  'Show the SAME box, from the identical camera angle, with its lid closed down',
  'flat onto the base.',
  '',
  'Everything else must be identical: the same cardboard, the same colour, the',
  'same proportions, the same logo printed on the lid in the same place and at',
  'the same size, the same lighting from the same direction, the same position',
  'and size in the frame. Nothing changes except that the lid is now shut.',
  '',
  background,
].join('\n')

// ------------------------------------------------------------------ main ---

const what = process.argv[2] || 'toppings'
await mkdir(propsSrc, { recursive: true })

const dest = (name, run) =>
  path.join(propsSrc, run > 0 ? `${name}-take${run + 1}.png` : `${name}.png`)

if (what === 'toppings') {
  // `node scripts/gen-props.mjs toppings cheese olives` regenerates only those.
  const only = process.argv.slice(3)
  const wanted = only.length
    ? Object.entries(TOPPINGS).filter(([id]) => only.includes(id))
    : Object.entries(TOPPINGS)
  const jobs = wanted.map(([id, desc]) => ({
    name: `topping-${id}`,
    prompt: toppingPrompt(desc),
    attach: [],
    runs: 1,
  }))
  console.log(`props: ${jobs.length} topping sheet(s)`)
  await runBatch(jobs, dest)
} else if (what === 'box') {
  // The lockup is cropped out of the brand sheet rather than handing over the
  // whole sheet, which is mostly empty cream and swatches - Gemini reproduces
  // what it is shown, so it should be shown the mark and nothing else.
  const logoFile = path.join(propsSrc, '_logo.png')
  const brand = await requireSource(root, 'logo', root)
  await sharp(brand).extract(LOGO_CROP).png().toFile(logoFile)
  const attach = [await upload(logoFile)]
  console.log('props: box (open) x3')
  await runBatch([{ name: 'box-open', prompt: boxOpenPrompt, attach, runs: 3 }], dest)
} else if (what === 'box-closed') {
  const ref = process.argv[3] || (await requireSource(propsSrc, 'box-open', root))
  const attach = [await upload(ref)]
  console.log(`props: box (closed) x2, from ${path.relative(root, ref)}`)
  await runBatch([{ name: 'box-closed', prompt: boxClosedPrompt, attach, runs: 2 }], dest)
} else {
  console.error('Usage: node scripts/gen-props.mjs <toppings|box|box-closed [ref.png]>')
  process.exit(1)
}
