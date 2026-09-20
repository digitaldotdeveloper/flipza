/**
 * Generates a flavour's nine tumble poses by *editing* the nine that already
 * exist, through the local Gemini Studio dashboard.
 *
 *   node scripts/gen-flavor.mjs veggie            # all nine poses
 *   node scripts/gen-flavor.mjs veggie --poses 1  # just one, to check the look
 *
 * Writes sprites-src/pizza-<flavour>-<n>.png. Sources are only ever read.
 *
 * Why editing rather than generating: the nine poses are one continuous toss,
 * and the runtime places them on a single arc by measuring each one. A pose
 * generated from a text prompt would come back at some unrelated rotation, and
 * no amount of measuring fixes a pizza that is tilted the wrong way. Handing
 * Gemini the existing pose and asking it to repaint only the toppings keeps the
 * rotation by construction - the geometry is never re-imagined, only the food
 * on top of it.
 *
 * Position and scale drift are expected and harmless: prepare-assets.mjs
 * re-measures every sprite from its alpha moments, so a pizza that comes back
 * smaller or off-centre is normalised on the way in. Rotation is the one thing
 * measuring cannot repair, which is why the prompt guards it so heavily.
 */
import { readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spriteSrc = path.join(root, 'sprites-src')

const HOST = process.env.GEMINI_STUDIO_HOST || 'http://127.0.0.1:4321'
const POSE_COUNT = 9

/**
 * What each flavour puts on the pizza.
 *
 * Written as an instruction to a painter, not as a menu description: it has to
 * say what to remove as well as what to add, or Gemini leaves the basil on and
 * simply piles the new toppings around it.
 */
const FLAVOURS = {
  // The two that already exist are here too, and for a reason: the original
  // nine poses are ONE toss, so margherita only exists at rotations 1-5 and
  // pepperoni only at 6-9. Tossing pepperoni -> margherita needs pepperoni
  // rising and margherita falling, and neither was ever drawn. Regenerating
  // both across all nine also puts every sprite through the same process, so
  // no flavour is subtly better-looking than its neighbours.
  margherita: {
    label: 'MARGHERITA',
    toppings:
      'round slices of fresh mozzarella and torn basil leaves over tomato ' +
      'sauce, with a little olive oil sheen - a classic margherita and nothing else',
  },
  pepperoni: {
    label: 'PEPPERONI',
    toppings:
      'evenly spaced overlapping slices of pepperoni, slightly cupped and ' +
      'crisped at their edges, over tomato sauce and melted mozzarella',
  },
  veggie: {
    label: 'VEGGIE',
    toppings:
      'strips of green bell pepper, black olive rings, thinly sliced brown ' +
      'mushrooms and slivers of red onion, scattered over tomato sauce with a ' +
      'little melted mozzarella showing between them',
  },
  diavola: {
    label: 'DIAVOLA',
    toppings:
      'overlapping slices of spicy salami, rings of fresh red chilli and a few ' +
      'black olives, over tomato sauce, with a faint sheen of chilli oil',
  },
  formaggi: {
    label: '4 FORMAGGI',
    toppings:
      'four melted cheeses and no tomato sauce at all - a pale golden pizza of ' +
      'mozzarella, gorgonzola, fontina and grated parmesan, blistered and ' +
      'bubbling in places, with no red anywhere',
  },
  speciale: {
    label: 'PIZZA SPECIALE',
    toppings:
      'ham, sliced mushrooms, black olives, artichoke hearts and a scattering ' +
      'of capers over tomato sauce and mozzarella',
  },
}

/**
 * The edit instruction.
 *
 * Almost all of it is about what must NOT change. Asked plainly for "the same
 * pizza with different toppings", Gemini re-frames it: a straightened, centred,
 * hero-lit pizza that is lovely on its own and useless as frame 4 of a toss.
 * Naming the tilt and the foreshortening as things to preserve is what keeps
 * the pose intact.
 *
 * Size and position are deliberately NOT pinned. prepare-assets.mjs re-measures
 * both, so asking for the pizza large in frame is free resolution - Gemini
 * returns about 1024px on the long edge whatever it is handed, and a pizza that
 * fills that frame carries more detail than one floating in the middle of it.
 *
 * The background is asked for as flat magenta rather than transparency.
 * "Transparent background" makes Gemini *paint a checkerboard* - a literal
 * picture of what transparency looks like in an image editor - which is opaque
 * and two-toned, the worst possible thing to key. Magenta appears nowhere in a
 * pizza, so the flood fill in prepare-assets can lift it in one pass.
 */
const CHROMA = '#FF00FF'

const prompt = (flavour) =>
  [
    'This is a photograph of a pizza seen at an angle, as it tumbles through',
    'the air.',
    '',
    'Keep the pizza itself EXACTLY as it is in every way except its toppings.',
    'Do not rotate it, do not straighten it, do not level it out. Keep the',
    'identical viewing angle, the identical tilt, and the identical elliptical',
    'foreshortening - it must stay squashed by perspective in exactly the same',
    'direction and amount. Keep the identical crust, with the same char marks,',
    'the same blisters and the same bubbled edge, and keep the same lighting',
    'and shadow direction across it.',
    '',
    'Change ONLY what is on top of the pizza. Remove the existing toppings',
    `completely and replace them with: ${flavour.toppings}.`,
    '',
    `Place it on a completely flat, uniform, solid ${CHROMA} magenta background.`,
    'The background must be one single colour with no gradient, no shading, no',
    'checkerboard, no pattern and no shadow cast onto it. Nothing else may',
    'appear in the frame - no plate, no table, no hands, no text.',
    '',
    'Show the pizza large in the frame, close to the edges.',
  ].join('\n')

// ---------------------------------------------------------------- studio ---

const token = process.env.GEMINI_STUDIO_TOKEN || ''

async function api(route, payload) {
  const res = await fetch(`${HOST}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  })
  if (res.status === 401) throw new Error('Studio rejected the token')
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`)
  return res.json()
}

async function state() {
  const res = await fetch(`${HOST}/api/state`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`/api/state -> HTTP ${res.status}`)
  return res.json()
}

/** Uploads a local PNG so Gemini can edit it. Returns an attachment ref. */
async function upload(file) {
  const data = await readFile(file)
  const out = await api('/api/upload', {
    name: path.basename(file),
    dataUrl: `data:image/png;base64,${data.toString('base64')}`,
  })
  if (out.error) throw new Error(`upload ${path.basename(file)}: ${out.error}`)
  return { kind: 'up', file: out.file }
}

/**
 * Blocks until every job in `ids` has left the queue.
 *
 * Polls rather than streams because the dashboard has no event channel, and a
 * 3s poll is nothing next to the ~25s an edit takes.
 */
async function settle(ids, onProgress) {
  const pending = new Set(ids)
  const deadline = Date.now() + 20 * 60 * 1000
  const done = new Map()
  while (pending.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const snap = await state()
    for (const job of snap.jobs) {
      if (!pending.has(job.id)) continue
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        pending.delete(job.id)
        done.set(job.id, job)
        onProgress?.(job, ids.length - pending.size, ids.length)
      }
    }
  }
  if (pending.size) throw new Error(`timed out waiting for ${[...pending].join(', ')}`)
  return done
}

async function download(libraryFile, dest) {
  const res = await fetch(`${HOST}/images/${libraryFile}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`download ${libraryFile} -> HTTP ${res.status}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

// ------------------------------------------------------------------ main ---

const [slug, ...rest] = process.argv.slice(2)
const flavour = FLAVOURS[slug]
if (!flavour) {
  console.error(`Usage: node scripts/gen-flavor.mjs <${Object.keys(FLAVOURS).join('|')}> [--poses 1,2,3]`)
  process.exit(1)
}

const posesArg = rest[rest.indexOf('--poses') + 1]
const poses =
  rest.includes('--poses') && posesArg
    ? posesArg.split(',').map((n) => parseInt(n, 10))
    : Array.from({ length: POSE_COUNT }, (_, i) => i + 1)

const model = rest.includes('--model') ? rest[rest.indexOf('--model') + 1] : 'auto'

console.log(`${flavour.label}: ${poses.length} pose(s) [${poses.join(', ')}] via ${model}`)

// Queue everything first, then wait. The dashboard runs `concurrency` jobs at a
// time and gives each prompt its own conversation, so nine submitted together
// finish far sooner than nine submitted one after another.
const queued = []
for (const n of poses) {
  const src = await requireSource(spriteSrc, `pizza-${n}`, root)
  const attach = await upload(src)
  const { queued: ids } = await api('/api/generate', {
    prompt: prompt(flavour),
    mode: 'image',
    model,
    runs: 1,
    threadId: null,
    attach: [attach],
  })
  queued.push({ pose: n, jobId: ids[0] })
  console.log(`  pose ${n} -> job ${ids[0]}`)
}

const finished = await settle(
  queued.map((q) => q.jobId),
  (job, at, total) => console.log(`  [${at}/${total}] ${job.id} ${job.status}`)
)

const { library } = await state()
let ok = 0
for (const { pose, jobId } of queued) {
  const job = finished.get(jobId)
  if (job.status !== 'done') {
    console.error(`  pose ${pose}: ${job.status}${job.error ? ` - ${job.error}` : ''}`)
    continue
  }
  // Newest first in the library, so the first match is this job's own result.
  const entry = library.find((i) => i.jobId === jobId && (i.kind || 'image') === 'image')
  if (!entry) {
    console.error(`  pose ${pose}: job finished but produced no image`)
    continue
  }
  const dest = path.join(spriteSrc, `pizza-${slug}-${pose}.png`)
  await download(entry.file, dest)
  console.log(`  pose ${pose}: ${entry.w}x${entry.h} -> ${path.relative(root, dest)}`)
  ok++
}

console.log(`${flavour.label}: ${ok}/${poses.length} written`)
if (ok < poses.length) process.exitCode = 1
