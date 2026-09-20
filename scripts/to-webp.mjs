/**
 * Converts generated PNG sources to lossless WebP.
 *
 *   node scripts/to-webp.mjs          # convert, keep the PNGs
 *   node scripts/to-webp.mjs --prune  # convert and delete the PNGs
 *
 * Run it after a generation batch. Gemini returns PNG and the generators write
 * what they are given; this is what makes the repository a reasonable size.
 *
 * Lossless, always. These are the files every sprite is keyed, measured and
 * cut from, and the alpha bounds, the centroid and the major axis in
 * sprite-data.json all come out of exact pixel values - a lossy re-encode
 * would move them, and would put a haze of magenta into the very edge pixels
 * that CHROMA_ERODE exists to get rid of. Lossless WebP is the same pixels in
 * about 40% of the bytes, so there is nothing to trade off.
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Every directory holding hand-kept or generated sources. */
const DIRS = ['sprites-src', 'oven-src', 'props-src', 'portrait-src']

/**
 * Files not worth converting or not worth keeping at all.
 *
 * The `_`-prefixed ones are inputs built for a single generation - the crop
 * shown to Gemini, the seed frame - and are rebuilt by the script that needs
 * them. Everything under pass1/ is a superseded take kept only for reference.
 */
const SKIP = /^_|[\\/]pass1[\\/]/

const prune = process.argv.includes('--prune')

let converted = 0
let before = 0
let after = 0

for (const dir of DIRS) {
  const full = path.join(root, dir)
  let entries
  try {
    entries = await readdir(full)
  } catch {
    continue
  }

  for (const name of entries) {
    if (!name.endsWith('.png') || SKIP.test(name)) continue
    const src = path.join(full, name)
    const dest = src.replace(/\.png$/, '.webp')

    const srcStat = await stat(src)
    let fresh = false
    try {
      fresh = (await stat(dest)).mtimeMs >= srcStat.mtimeMs
    } catch {
      // not converted yet
    }

    if (!fresh) {
      await sharp(src).webp({ lossless: true, effort: 5 }).toFile(dest)
      converted++
    }
    before += srcStat.size
    after += (await stat(dest)).size
    if (prune) await unlink(src)
  }
}

const mb = (b) => (b / 1048576).toFixed(1)
console.log(
  `to-webp: ${converted} converted, ${mb(before)}MB of PNG -> ${mb(after)}MB of WebP` +
    (prune ? ' (PNGs removed)' : '')
)
