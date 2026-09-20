/**
 * Gets the scene on screen as fast as possible, then fills in the rest.
 *
 * The old loader blocked on all 64 bitmaps before the first frame, which was
 * tolerable at three flavours and not at six. Nothing can be tossed until a
 * flavour is tapped, so there is a whole interaction's worth of time to fill:
 *
 *   critical   the plate, the peel and pose 1 of every flavour - enough to
 *              draw a resting pizza and let someone tap. Six-odd images.
 *   rest       poses 2..9 per flavour, then the fire, then the box and the
 *              toppings - in the order they can first be needed.
 *
 * `ensure(flavour)` jumps a flavour to the front of that queue, so tapping
 * something that has not streamed in yet fetches it immediately rather than
 * waiting its turn behind five others.
 */
import { FLAVORS, PEEL, PLATE, POSE_COUNT, posesFor } from '../scene'
import type { Flavor } from '../scene'
import { EXTRAS } from '../menu'
import { boxUrls, fireFrameUrls, toppingUrls } from '../props'
import type { SceneAssets } from './renderer'

/**
 * Decodes one asset to a bitmap.
 *
 * Through an `<img>` rather than `fetch()` because the standalone build is
 * opened straight off disk, where a fetch of any URL - including a data URI in
 * some engines - is treated as cross-origin and blocked. Image loading is not.
 */
async function loadBitmap(src: string) {
  const img = new Image()
  img.decoding = 'async'
  img.src = src
  await img.decode()
  return createImageBitmap(img)
}

/** Runs `work` over `items`, `limit` at a time, in order. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await work(items[i])
    }
  })
  await Promise.all(runners)
}

export interface LoadHandle {
  assets: SceneAssets
  /** Fetches a flavour's remaining poses now, ahead of the queue. */
  ensure(flavor: Flavor): Promise<void>
  /** Resolves when everything, including props, has been decoded. */
  complete: Promise<void>
  cancel(): void
}

export async function loadScene(onProgress?: (done: number, total: number) => void): Promise<LoadHandle> {
  let cancelled = false
  const assets: SceneAssets = {
    plate: null as unknown as ImageBitmap,
    peel: null as unknown as ImageBitmap,
    poses: {},
    flames: [],
    toppings: {},
  }

  // ------------------------------------------------------------ critical ---

  const firstPose = FLAVORS.map((f) => ({ flavor: f, src: posesFor(f)[0].src }))
  const criticalTotal = 2 + firstPose.length
  let done = 0
  const tick = () => onProgress?.(++done, criticalTotal)

  const [plate, peel] = await Promise.all([
    loadBitmap(PLATE.src).then((b) => (tick(), b)),
    loadBitmap(PEEL.src).then((b) => (tick(), b)),
  ])
  assets.plate = plate
  assets.peel = peel

  await Promise.all(
    firstPose.map(async ({ flavor, src }) => {
      const bmp = await loadBitmap(src)
      // A one-pose flavour is drawable: the renderer falls back to pose 1 for
      // any index it has not got yet, so an early tap cuts instead of tumbling
      // rather than failing.
      assets.poses[flavor] = [bmp]
      tick()
    })
  )

  if (cancelled) throw new Error('cancelled')

  // ---------------------------------------------------------------- rest ---

  const pending = new Map<Flavor, Promise<void>>()

  const fillFlavor = (flavor: Flavor) => {
    let p = pending.get(flavor)
    if (p) return p
    p = (async () => {
      const srcs = posesFor(flavor).slice(1)
      const bmps = await Promise.all(srcs.map((s) => loadBitmap(s.src)))
      if (cancelled) return bmps.forEach((b) => b.close())
      // Assigned in one go: a half-filled array would let the renderer index
      // into a hole mid-toss.
      assets.poses[flavor] = [assets.poses[flavor][0], ...bmps]
    })()
    pending.set(flavor, p)
    return p
  }

  const complete = (async () => {
    // Flavours first - they are the only thing a tap needs. Two at a time:
    // enough to keep the connection busy, few enough that an `ensure` jumping
    // the queue is not stuck behind a wall of requests.
    await pool([...FLAVORS], 2, async (f) => {
      await fillFlavor(f)
    })
    if (cancelled) return

    // Then the fire. It is the first thing that plays on its own, but the
    // scene is perfectly watchable without it, so it comes after the toss.
    const flames = await Promise.all(fireFrameUrls().map(loadBitmap))
    if (cancelled) return flames.forEach((b) => b.close())
    assets.flames = flames

    // Then the props for the end of the flow, which cannot be reached in less
    // time than this takes.
    const { open, mid, closed } = boxUrls()
    if (open) assets.boxOpen = await loadBitmap(open).catch(() => undefined)
    if (mid) assets.boxMid = await loadBitmap(mid).catch(() => undefined)
    if (closed) assets.boxClosed = await loadBitmap(closed).catch(() => undefined)
    for (const extra of EXTRAS) {
      const urls = toppingUrls(extra.sprite)
      if (!urls.length) continue
      const pieces = await Promise.all(urls.map((u) => loadBitmap(u).catch(() => null)))
      if (cancelled) return
      assets.toppings[extra.id] = pieces.filter((p): p is ImageBitmap => !!p)
    }
  })()

  return {
    assets,
    ensure: (flavor) => fillFlavor(flavor),
    complete,
    cancel() {
      cancelled = true
      assets.plate?.close()
      assets.peel?.close()
      Object.values(assets.poses).forEach((set) => set.forEach((b) => b?.close()))
      assets.flames.forEach((b) => b.close())
      assets.boxOpen?.close()
      assets.boxMid?.close()
      assets.boxClosed?.close()
      Object.values(assets.toppings).forEach((set) => set.forEach((b) => b.close()))
    },
  }
}

export { POSE_COUNT }
