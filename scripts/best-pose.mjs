/**
 * Regenerates one pose several times and keeps the take whose rotation best
 * matches the original.
 *
 *   node scripts/best-pose.mjs diavola 1          # 4 takes, keep the closest
 *   node scripts/best-pose.mjs speciale 2 --takes 6
 *
 * Why this exists: pose 1 is the flat resting pose and Gemini keeps
 * straightening it toward top-down. A plain retry is a coin flip that usually
 * lands worse than what it overwrote - measured 0.492 -> 0.593 on diavola,
 * having already gone 0.461 -> 0.499 -> 0.602 on an earlier flavour. The drift
 * is not a bias that a better prompt removes, it is spread; so take several and
 * pick, rather than retrying and hoping.
 *
 * The measurement is minor/major axis ratio, i.e. foreshortening, which is the
 * one thing prepare-assets cannot normalise away. Position and scale drift are
 * re-measured at pack time and are harmless.
 *
 * Measuring goes through prepare-assets rather than reimplementing the keying:
 * that pass is incremental (isFresh), so re-running it after one changed source
 * only reprocesses that sprite. The number under test is therefore produced by
 * exactly the pipeline that ships, not by a parallel copy of it that can drift.
 */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spriteSrc = path.join(root, 'sprites-src')
const dataFile = path.join(root, 'src', 'sprite-data.json')

const [slug, poseArg, ...rest] = process.argv.slice(2)
const pose = Number(poseArg)
if (!slug || !Number.isInteger(pose)) {
  console.error('Usage: node scripts/best-pose.mjs <flavour> <pose> [--takes N]')
  process.exit(1)
}
const takes = rest.includes('--takes') ? Number(rest[rest.indexOf('--takes') + 1]) : 4

const run = (script, args) =>
  execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  })

const ratioOf = async (name) => {
  const { sprites } = JSON.parse(await readFile(dataFile, 'utf8'))
  const s = sprites[name]
  return s ? s.minor / s.major : null
}

const live = path.join(spriteSrc, `pizza-${slug}-${pose}.png`)
const stash = path.join(spriteSrc, '.takes')
await mkdir(stash, { recursive: true })

// The current file is take 0 - it may already be the best one available, and
// nothing here is allowed to lose ground against what it started with.
run('prepare-assets.mjs', [])
const target = await ratioOf(`pizza-${pose}`)
const candidates = []
const record = async (n) => {
  const keep = path.join(stash, `${slug}-${pose}-${n}.png`)
  await copyFile(live, keep)
  const r = await ratioOf(`pizza-${slug}-${pose}`)
  candidates.push({ file: keep, ratio: r })
  const dev = ((r - target) / target) * 100
  console.log(`  take ${n}: ${r.toFixed(3)} (${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%)`)
}

console.log(`${slug} pose ${pose}: target ${target.toFixed(3)}, ${takes} take(s)`)
await record(0)

for (let n = 1; n <= takes; n++) {
  run('gen-flavor.mjs', [slug, '--poses', String(pose)])
  run('prepare-assets.mjs', [])
  await record(n)
}

candidates.sort((a, b) => Math.abs(a.ratio - target) - Math.abs(b.ratio - target))
const best = candidates[0]
const dev = ((best.ratio - target) / target) * 100
console.log(`keeping ${path.basename(best.file)} -> ${best.ratio.toFixed(3)} (${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%)`)

await copyFile(best.file, live)
await rm(stash, { recursive: true, force: true })
run('prepare-assets.mjs', [])
