/**
 * Finding a source file whatever it was stored as.
 *
 * Generators write PNG, because that is what comes back from Gemini. The
 * repository stores WebP, because a lossless WebP of a 1024px render is about
 * 60% smaller than the same pixels as PNG and *is* the same pixels - keying,
 * measuring and every number in sprite-data.json come out identical. Running
 * scripts/to-webp.mjs converts one into the other.
 *
 * So every script that reads a source asks for it by name without an
 * extension, and gets whichever exists. WebP first: after a conversion both
 * may be sitting there, and the WebP is the one that was kept on purpose.
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'

const ORDER = ['.webp', '.png']

/** The first existing `<dir>/<base><ext>`, or null. */
export async function findSource(dir, base) {
  for (const ext of ORDER) {
    const file = path.join(dir, base + ext)
    try {
      await stat(file)
      return file
    } catch {
      // next extension
    }
  }
  return null
}

/** Same, but throws with a readable message naming what was looked for. */
export async function requireSource(dir, base, root = dir) {
  const found = await findSource(dir, base)
  if (!found) {
    throw new Error(
      `missing source ${path.relative(root, path.join(dir, base))}${ORDER.join('|')}`
    )
  }
  return found
}

/** The first of several names that exists - for "this, else fall back to that". */
export async function pickSource(candidates) {
  for (const { dir, base } of candidates) {
    const found = await findSource(dir, base)
    if (found) return found
  }
  return null
}

/** Strips a known source extension off a filename. */
export const baseName = (file) => file.replace(/\.(webp|png)$/i, '')

/** Whether a filename is a source image at all. */
export const isSource = (file) => /\.(webp|png)$/i.test(file)
