/**
 * Prints every sprite's foreshortening against the original pose it was painted
 * from. Run it after generating a flavour:
 *
 *   node scripts/check-poses.mjs
 *
 * The number is minor/major axis ratio, i.e. how squashed by perspective the
 * pizza is. It is the one check that matters, because it is the one kind of
 * drift prepare-assets cannot repair - position and scale are re-measured at
 * pack time, rotation is not. A pose that came back at the wrong angle pops for
 * a single frame mid-toss, which reads as a glitch rather than as a mistake.
 *
 * Anything within about +-2% is the normal spread of the generation. Anything
 * past that wants `best-pose.mjs <flavour> <pose>`.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { poseCount, flavours, sprites } = JSON.parse(
  await readFile(path.join(root, 'src', 'sprite-data.json'), 'utf8'),
)

const ratio = (name) => (sprites[name] ? sprites[name].minor / sprites[name].major : null)
const TOLERANCE = 2

console.log('pose  orig   ' + flavours.map((f) => f.padEnd(15)).join(''))
let flagged = 0
for (let n = 1; n <= poseCount; n++) {
  const base = ratio(`pizza-${n}`)
  const cells = flavours.map((f) => {
    const r = ratio(`pizza-${f}-${n}`)
    if (r == null) return 'missing'.padEnd(15)
    const dev = ((r - base) / base) * 100
    if (Math.abs(dev) > TOLERANCE) flagged++
    const mark = Math.abs(dev) > TOLERANCE ? ' <-' : ''
    return `${r.toFixed(3)} ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%${mark}`.padEnd(15)
  })
  console.log(String(n).padEnd(5), base.toFixed(3), cells.join(''))
}

console.log(
  flagged
    ? `\n${flagged} pose(s) past ${TOLERANCE}% - rerun with: node scripts/best-pose.mjs <flavour> <pose>`
    : `\nall poses within ${TOLERANCE}%`,
)
