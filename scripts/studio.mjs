/**
 * Client for the local Gemini Studio dashboard.
 *
 * Lifted out of gen-flavor.mjs when a second generator (the oven fire) needed
 * the same four calls. The dashboard has no event channel, so `settle` polls;
 * a 3s poll is nothing next to the ~25s an edit takes.
 *
 * Jobs are queued first and waited on afterwards, never one at a time: the
 * dashboard runs `concurrency` of them in parallel and gives each prompt its
 * own conversation, so ten submitted together finish far sooner than ten
 * submitted in sequence.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const HOST = process.env.GEMINI_STUDIO_HOST || 'http://127.0.0.1:4321'
const token = process.env.GEMINI_STUDIO_TOKEN || ''

const auth = () => (token ? { authorization: `Bearer ${token}` } : {})

async function api(route, payload) {
  const res = await fetch(`${HOST}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify(payload ?? {}),
  })
  if (res.status === 401) throw new Error('Studio rejected the token')
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`)
  return res.json()
}

export async function state() {
  const res = await fetch(`${HOST}/api/state`, { headers: auth() })
  if (!res.ok) throw new Error(`/api/state -> HTTP ${res.status}`)
  return res.json()
}

/** Uploads a local PNG so Gemini can edit it. Returns an attachment ref. */
export async function upload(file) {
  const data = await readFile(file)
  const out = await api('/api/upload', {
    name: path.basename(file),
    dataUrl: `data:image/png;base64,${data.toString('base64')}`,
  })
  if (out.error) throw new Error(`upload ${path.basename(file)}: ${out.error}`)
  return { kind: 'up', file: out.file }
}

/** Queues one prompt. Returns the job ids - one per run. */
export async function generate({ prompt, attach = [], runs = 1, model = 'auto' }) {
  const { queued } = await api('/api/generate', {
    prompt,
    mode: 'image',
    model,
    runs,
    threadId: null,
    attach,
  })
  return queued
}

/** Blocks until every job in `ids` has left the queue. */
export async function settle(ids, onProgress) {
  const pending = new Set(ids)
  const deadline = Date.now() + 25 * 60 * 1000
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

export async function download(libraryFile, dest) {
  const res = await fetch(`${HOST}/images/${libraryFile}`, { headers: auth() })
  if (!res.ok) throw new Error(`download ${libraryFile} -> HTTP ${res.status}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

/**
 * Queue -> wait -> download, for a batch of independent prompts.
 *
 * `jobs` is [{ name, prompt, attach, runs }]; each result is written to
 * `dest(name, runIndex)`. A job that fails is reported and skipped rather than
 * failing the batch, because a batch of ten with one bad take is still nine
 * usable frames.
 */
export async function runBatch(jobs, dest) {
  const queued = []
  for (const job of jobs) {
    const ids = await generate(job)
    ids.forEach((id, run) => queued.push({ name: job.name, run, id }))
    console.log(`  ${job.name}${job.runs > 1 ? ` x${job.runs}` : ''} -> ${ids.join(', ')}`)
  }

  const finished = await settle(
    queued.map((q) => q.id),
    (job, at, total) => console.log(`  [${at}/${total}] ${job.id} ${job.status}`)
  )

  const { library } = await state()
  const written = []
  for (const { name, run, id } of queued) {
    const job = finished.get(id)
    if (job.status !== 'done') {
      console.error(`  ${name}: ${job.status}${job.error ? ` - ${job.error}` : ''}`)
      continue
    }
    // Newest first in the library, so entries for this job are its own runs.
    const entries = library.filter((i) => i.jobId === id && (i.kind || 'image') === 'image')
    const entry = entries[Math.min(run, entries.length - 1)]
    if (!entry) {
      console.error(`  ${name}: job finished but produced no image`)
      continue
    }
    const file = dest(name, run)
    await download(entry.file, file)
    console.log(`  ${name}: ${entry.w}x${entry.h} -> ${file}`)
    written.push({ name, run, file })
  }
  return written
}
