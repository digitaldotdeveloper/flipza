/**
 * Gets the scene on screen as fast as possible, then fills in the rest.
 *
 * The old loader blocked on all 64 bitmaps before the first frame, which was
 * tolerable at three flavours and not at six. Nothing can be tapped until the
 * page has drawn, so there is a whole interaction's worth of time to fill:
 *
 *   critical   the plate, the peel and pose 1 of every flavour - enough to
 *              draw a resting pizza and let someone tap. Eight-odd images.
 *   streamed   everything else, in the order it can first be *seen*, which is
 *              not the order it can first be needed.
 *
 * Two things stop that order from ever being wrong:
 *
 *   - every group is a `once()` promise, so asking for it twice runs it once,
 *     and the stream can simply await the same promise the caller did;
 *   - anything reachable early can be pulled forward - `ensure(flavour)` when
 *     a flavour is tapped, `ensureToppings()` when the extras step opens. A
 *     tap never waits behind something nobody is looking at.
 *
 * The cost of getting this wrong is invisible and easy to miss: nothing errors,
 * the feature just silently does nothing the first few times it is used. The
 * toppings arrived about ten seconds in when they were last in the queue, which
 * is long after the extras step can be reached.
 */
import { FLAVORS, PEEL, PLATE, POSE_COUNT, posesFor } from '../scene'
import type { Flavor } from '../scene'
import { EXTRAS } from '../menu'
import { boxFrameUrls, fireFrameUrls, sideUrls, toppingUrls } from '../props'
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

/** Runs at most once, however many times it is called. */
function once<T>(fn: () => Promise<T>) {
  let p: Promise<T> | null = null
  return () => (p ??= fn())
}

/** Loads a list of urls into an array, keeping the list's order. */
async function loadAll(urls: string[], limit: number) {
  const out = new Array<ImageBitmap>(urls.length)
  await pool(
    urls.map((url, i) => ({ url, i })),
    limit,
    async ({ url, i }) => {
      out[i] = await loadBitmap(url)
    }
  )
  return out
}

export interface LoadHandle {
  assets: SceneAssets
  /** Fetches a flavour's remaining poses now, ahead of the queue. */
  ensure(flavor: Flavor): Promise<void>
  /** Fetches the topping pieces now - called when the extras step opens. */
  ensureToppings(): Promise<void>
  /** Resolves when everything has been decoded. */
  complete: Promise<void>
  cancel(): void
}

export async function loadScene(
  onProgress?: (done: number, total: number) => void
): Promise<LoadHandle> {
  let cancelled = false
  const assets: SceneAssets = {
    plate: null as unknown as ImageBitmap,
    peel: null as unknown as ImageBitmap,
    poses: {},
    flames: [],
    boxFrames: [],
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

  // ------------------------------------------------------------- groups ---

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

  /**
   * The fire. It is the only thing on screen that moves on its own, it is what
   * says the kitchen is alive, and it is the first thing anybody looks at -
   * which is why it goes before two and a half megabytes of tumble poses that
   * nothing can use until something is tapped.
   */
  const loadFire = once(async () => {
    const flames = await loadAll(fireFrameUrls(), 4)
    if (cancelled) return flames.forEach((b) => b?.close())
    assets.flames = flames
  })

  /** The extras, which are two taps away and so cannot wait for the box. */
  const loadToppings = once(async () => {
    for (const extra of EXTRAS) {
      const urls = toppingUrls(extra.sprite)
      if (!urls.length) continue
      const pieces = await Promise.all(urls.map((u) => loadBitmap(u).catch(() => null)))
      if (cancelled) return
      assets.toppings[extra.id] = pieces.filter((p): p is ImageBitmap => !!p)
    }
  })

  /** The box and the sides, which are the furthest thing from a first tap. */
  const loadProps = once(async () => {
    const boxFrames = await loadAll(boxFrameUrls(), 3)
    if (cancelled) return boxFrames.forEach((b) => b?.close())
    // Assigned in one go: a half-filled sequence would let the lid animation
    // index into a hole part way down.
    assets.boxFrames = boxFrames.filter(Boolean)

    const side = sideUrls()
    if (side.fries) assets.fries = await loadBitmap(side.fries).catch(() => undefined)
    if (side.cola) assets.cola = await loadBitmap(side.cola).catch(() => undefined)
  })

  const complete = (async () => {
    await loadFire()
    if (cancelled) return
    // Two flavours at a time: enough to keep the connection busy, few enough
    // that an `ensure` jumping the queue is not stuck behind a wall of them.
    await pool([...FLAVORS], 2, async (f) => {
      await fillFlavor(f)
    })
    if (cancelled) return
    await loadToppings()
    if (cancelled) return
    await loadProps()
  })()

  return {
    assets,
    ensure: (flavor) => fillFlavor(flavor),
    ensureToppings: loadToppings,
    complete,
    cancel() {
      cancelled = true
      assets.plate?.close()
      assets.peel?.close()
      Object.values(assets.poses).forEach((set) => set.forEach((b) => b?.close()))
      assets.flames.forEach((b) => b?.close())
      assets.boxFrames.forEach((b) => b?.close())
      assets.fries?.close()
      assets.cola?.close()
      Object.values(assets.toppings).forEach((set) => set.forEach((b) => b.close()))
    },
  }
}

export { POSE_COUNT }
