/**
 * The generated props: the oven fire, the box and the topping pieces.
 *
 * Kept apart from sprite-data.json because the two are built by different
 * scripts from different sources, and because these are all *optional* - the
 * site runs without any of them, just with a still fire and no box animation.
 * A prop that has not been generated yet reports zero frames and every consumer
 * skips it, so a half-built checkout never breaks the toss.
 */
import propData from './prop-data.json'
import { asset } from './assets'

interface FireData {
  /** Where the flame frames are composited, in plate pixels. */
  left: number
  top: number
  width: number
  height: number
  frames: number
  /** Per-frame mean luminance, normalised 0..1 - drives the light spill. */
  brightness: number[]
}

interface PlateData {
  /** Size of the plate bitmap, which may be taller than the scene. */
  width: number
  height: number
  /**
   * Where the scene's origin sits inside that bitmap. The scene coordinate
   * system is the original 1672x941 kitchen, and the portrait extension adds
   * picture above and below it - so plate pixel (left, top) is scene (0, 0),
   * and scene coordinates run negative above the original top edge.
   */
  left: number
  top: number
}

interface PropData {
  fire: FireData
  plate: PlateData
  box: { open: boolean; mid: boolean; closed: boolean }
  /** Pieces cut from each topping sheet, keyed by extra id. */
  toppings: Record<string, number>
}

const data = propData as PropData

export const FIRE = data.fire
export const PLATE_IMAGE = data.plate
export const PROPS = { box: data.box, toppings: data.toppings }

export const fireFrameUrls = () =>
  Array.from({ length: FIRE.frames }, (_, i) =>
    asset(`fire/flame-${String(i + 1).padStart(2, '0')}.webp`)
  )

export const boxUrls = () => ({
  open: data.box.open ? asset('props/box-open.webp') : null,
  mid: data.box.mid ? asset('props/box-mid.webp') : null,
  closed: data.box.closed ? asset('props/box-closed.webp') : null,
})

export const toppingUrls = (extra: string) =>
  Array.from({ length: data.toppings[extra] ?? 0 }, (_, i) =>
    asset(`toppings/${extra}-${String(i + 1).padStart(2, '0')}.webp`)
  )

export const hasFire = () => FIRE.frames > 0
