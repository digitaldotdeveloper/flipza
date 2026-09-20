/**
 * Generates the material for a live oven fire, through the local Gemini Studio
 * dashboard.
 *
 *   node scripts/gen-oven.mjs            # embers + all flame frames
 *   node scripts/gen-oven.mjs --flames 4 # just four flames, to check the look
 *
 * Writes into oven-src/. Sources are only ever read.
 *
 * Two things are needed, and they are generated separately on purpose:
 *
 *   embers.png    the oven cavity with the fire burned down - logs and glowing
 *                 coals, no flames. The still plate has flames painted into it,
 *                 and animated flames drawn on top of painted ones reads as two
 *                 fires. prepare-oven.mjs patches this back into the cavity so
 *                 the plate underneath the animation is genuinely flameless.
 *
 *   flame-N.png   the flames on their own, on flat magenta, one per frame.
 *
 * Why the flames are generated apart from the oven rather than as N versions of
 * the whole cavity: N independent renders of the same oven would each re-imagine
 * the bricks, the logs and the coals slightly differently, and cutting between
 * them would make the whole oven crawl. Only the flames should move. Keyed out
 * and composited additively, a flame frame changes nothing but its own light.
 *
 * The magenta background is the same trick the pizza sprites use, and for the
 * same reason - asked for transparency Gemini paints a checkerboard. It suits
 * fire even better: flame edges are soft and semi-transparent, so the key is a
 * ramp rather than a threshold, and what survives is drawn with `lighter`.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { requireSource } from './sources.mjs'
import { runBatch, upload } from './studio.mjs'
import { CONTEXT } from './geometry.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ovenSrc = path.join(root, 'oven-src')
const spriteSrc = path.join(root, 'sprites-src')

const CHROMA = '#FF00FF'

/**
 * One prompt per frame.
 *
 * Deliberately not ten runs of one prompt: independent runs of a single prompt
 * cluster around one shape, and a fire that returns to the same silhouette ten
 * times a second reads as a loop rather than as a fire. Describing a different
 * gesture each time spreads them out. They are ordered into a smooth cycle
 * afterwards by prepare-oven.mjs, which sorts them by height, so the order
 * written here does not matter.
 */
const FLAMES = [
  'a tall central column of flame, narrow, with its tips leaning slightly right',
  'a low broad sheet of flame spread right across the log bed, hugging the coals',
  'two separate tongues of flame, a tall one on the left and a short one on the right',
  'a wide flame curling over to the left, its tip trailing sideways',
  'a tall narrow flame, almost vertical, with a small detached wisp above its tip',
  'three medium tongues of flame licking upward side by side',
  'a bright wide burst of flame, thick at the base, with a few sparks above it',
  'a flame leaning right with one long trailing tip',
  'a medium flame fanned out into a broad triangle, brightest at its core',
  'a tall billowing flame, its top half breaking into separate licks',
]

/**
 * The variations asked for when the frames are generated from a seed frame.
 *
 * This is the mode that actually produces usable animation. Ten independent
 * prompts come back as ten different fires - different colour, different
 * style, one of them a candle - and cutting between them reads as a fault
 * rather than as a flame. Handing Gemini one frame of a fire and asking for
 * the same fire an instant later anchors every frame to the same look, exactly
 * the way gen-flavor.mjs anchors every pose to the same rotation.
 */
const MOTION = [
  'the tallest tongue has just fallen back and a new one is rising beside it',
  'the flames have leaned a little to the left',
  'the whole fire has risen slightly and its tips have split apart',
  'the flames have leaned a little to the right',
  'the fire has dropped closer to the logs for a moment',
  'one tongue on the left has shot up above the others',
  'the tips have curled over and are breaking into separate licks',
  'the fire has flared brighter and wider across its base',
  'a tongue on the right has risen while the left has dropped',
  'the flames have settled into an even, steady sheet',
]

const seedPrompt = (motion) =>
  [
    'The attached photograph shows flames on a flat magenta background.',
    '',
    'Show the SAME fire a fraction of a second later, as the very next frame of',
    `a video of it would look: ${motion}.`,
    '',
    'It must be unmistakably the same fire. Keep the identical colour and',
    'brightness, the identical overall height and width, the identical position',
    'in the frame, and the identical photographic quality and softness of the',
    'flame edges. Only the shapes of the individual tongues change, and only as',
    'much as flames change from one video frame to the next - this is the same',
    'fire moving, not a different fire.',
    '',
    'The base of the flames stays exactly on the bottom edge of the frame.',
    '',
    `Keep the background flat, uniform, solid ${CHROMA} magenta, with no glow,`,
    'no halo and no light spilling onto it. Nothing else in the frame.',
  ].join('\n')

const flamePrompt = (shape) =>
  [
    'The attached photograph is the inside of a wood-fired pizza oven.',
    '',
    `Paint ONLY the flames from that fire: ${shape}.`,
    '',
    'Match the fire in the photograph exactly - the same deep orange and amber',
    'colour, the same soft glowing edges, the same warmth and the same',
    'photographic quality. It must look like a frame from a video of that exact',
    'fire.',
    '',
    'Nothing else may appear: no oven, no bricks, no arch, no logs, no coals, no',
    'floor, no smoke, no text. The flames alone.',
    '',
    `The background must be flat, uniform, solid ${CHROMA} magenta - one single`,
    'colour with no gradient, no shading, no checkerboard and no glow spilling',
    'onto it.',
    '',
    'The base of the flames must sit exactly on the bottom edge of the frame, as',
    'if the burning logs were just below it, and the flames must fill most of the',
    'height of the frame.',
  ].join('\n')

const embersPrompt = [
  'This is a photograph of the mouth of a wood-fired pizza oven with a fire',
  'burning in it.',
  '',
  'Put the fire out. Remove every flame completely, so that not one tongue of',
  'fire is left anywhere in the frame.',
  '',
  'Leave behind exactly what the fire was burning: the same logs in the same',
  'places and the same bed of glowing embers, still hot and glowing deep orange',
  'and red. The back wall and floor of the oven keep their warm glow from the',
  'coals, just without any flames in front of them.',
  '',
  'Everything else in the frame must stay EXACTLY as it is - the identical brick',
  'arch, the identical stone, the identical camera angle and framing, the',
  'identical lighting direction. Do not move, resize or recolour anything.',
  'Change nothing except removing the flames.',
].join('\n')

// ------------------------------------------------------------------ main ---

const args = process.argv.slice(2)
/**
 * `--seed oven-src/flame-07.png` regenerates the flames as frames of *that*
 * fire rather than as ten fires of their own. Use it once a first pass has
 * produced one flame worth keeping.
 */
const seed = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : null
const flameCount = args.includes('--flames')
  ? Math.max(1, Math.min(10, parseInt(args[args.indexOf('--flames') + 1], 10) || 0))
  : FLAMES.length
const skipEmbers = args.includes('--no-embers') || !!seed

await mkdir(ovenSrc, { recursive: true })

// The two crops Gemini is shown. The context crop carries brick on every side
// so the embers edit has something to hold on to; the flames are described
// against the same crop so they come back in that fire's own colour.
let attach
if (seed) {
  console.log(`seed -> ${path.relative(root, seed)}`)
  attach = [await upload(path.resolve(root, seed))]
} else {
  const contextFile = path.join(ovenSrc, '_context.png')
  const plate = await requireSource(spriteSrc, 'plate', root)
  await sharp(plate).extract(CONTEXT).resize({ width: CONTEXT.width * 2 }).png().toFile(contextFile)
  console.log(`context crop -> ${path.relative(root, contextFile)}`)
  attach = [await upload(contextFile)]
}

const jobs = []
if (!skipEmbers) {
  // Two takes: the flames are the brightest thing in the crop and a take that
  // leaves a ghost of one is useless, so it is worth having a spare.
  jobs.push({ name: 'embers', prompt: embersPrompt, attach, runs: 2 })
}
const variants = seed ? MOTION : FLAMES
variants.slice(0, flameCount).forEach((v, i) => {
  jobs.push({
    name: `flame-${String(i + 1).padStart(2, '0')}`,
    prompt: seed ? seedPrompt(v) : flamePrompt(v),
    attach,
    runs: 1,
  })
})

console.log(`oven: ${jobs.length} job(s)`)
const written = await runBatch(jobs, (name, run) =>
  path.join(ovenSrc, run > 0 ? `${name}-take${run + 1}.png` : `${name}.png`)
)
console.log(`oven: ${written.length} image(s) written to ${path.relative(root, ovenSrc)}`)
