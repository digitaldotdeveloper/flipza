/**
 * Folds the `--mode standalone` build into a single self-contained HTML file at
 * the repo root, so the hero can be opened by double-clicking it - no dev
 * server, no web host, nothing else next to it.
 *
 *   dist-standalone/  ->  flipza.html
 *
 * Opened over file://, a page cannot load an external module script and cannot
 * fetch a sibling file - both are cross-origin. So the script, the stylesheet
 * and all ten images have to travel inside the document itself: the first two
 * as inline tags, the images as data URIs on `window.__FLIPZA_ASSETS__`, which
 * src/assets.ts reads in preference to a URL.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'dist-standalone')
const publicDir = path.join(root, 'public')
const dest = path.join(root, 'flipza.html')

/** Neutralises a closing tag that would otherwise end the inline script early. */
const escapeForInlineScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1')

async function dataUri(file) {
  const buf = await readFile(file)
  return `data:image/webp;base64,${buf.toString('base64')}`
}

/**
 * Every runtime asset, keyed by the path src/assets.ts would have requested -
 * i.e. its path relative to public/, which is exactly what `asset()` builds.
 */
async function collectAssets() {
  const entries = []

  const walk = async (dir) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        await walk(full)
      } else if (item.name.endsWith('.webp')) {
        const key = path.relative(publicDir, full).split(path.sep).join('/')
        entries.push([key, await dataUri(full)])
      }
    }
  }

  await walk(publicDir)
  return Object.fromEntries(entries)
}

const html = await readFile(path.join(buildDir, 'index.html'), 'utf8')

const scriptTag = html.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/i)
const styleTag = html.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/i)
if (!scriptTag) throw new Error('No bundled script found in dist-standalone/index.html')

const resolve = (url) => path.join(buildDir, url.replace(/^\.?\//, ''))
const js = await readFile(resolve(scriptTag[1]), 'utf8')
const css = styleTag ? await readFile(resolve(styleTag[1]), 'utf8') : ''
const assets = await collectAssets()

const payload = escapeForInlineScript(
  `window.__FLIPZA_ASSETS__=${JSON.stringify(assets)};\n${js}`
)

// Every replacement below goes through a function, never a replacement string:
// minified JS and base64 are full of `$&` and `$'`, which a string replacement
// expands as backreferences and splices the document into itself.
//
// Order matters too - the document is rewritten first and the bundle injected
// last, so none of these patterns can match inside the bundle's own text.
let out = html
  // Vite emits the script into <head>, which is fine for a module script -
  // those are deferred - but an inline classic script runs the moment it is
  // parsed, before #root exists. It gets re-inserted at the end of <body>.
  .replace(scriptTag[0], '')
  // A modulepreload for a script that is no longer fetched is a 404 waiting to
  // happen, and the favicon has to be inlined like everything else.
  .replace(/\s*<link\b[^>]*\brel="modulepreload"[^>]*>/gi, '')
  .replace(
    /(<link\b[^>]*\brel="icon"[^>]*\bhref=")[^"]*(")/i,
    (_m, open, close) => `${open}${assets['logo.webp']}${close}`
  )

if (styleTag) out = out.replace(styleTag[0], () => `<style>${css}</style>`)

if (!/<\/body>/i.test(out)) throw new Error('No </body> to inject the bundle before')
out = out.replace(
  /([ \t]*)<\/body>/i,
  (_m, indent) => `${indent}  <script>${payload}</script>\n${indent}</body>`
)

await writeFile(dest, out, 'utf8')

const mb = (Buffer.byteLength(out) / 1024 / 1024).toFixed(2)
console.log(
  `standalone: ${path.relative(root, dest)}  ${mb} MB  ` +
    `(${Object.keys(assets).length} assets inlined) - double-click to open`
)
