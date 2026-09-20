/**
 * The canvas engine.
 *
 * Everything visible is drawn here, from a plain mutable state object that
 * something else animates - GSAP owns the numbers, this owns the pixels. The
 * split matters: the ordering flow tweens `size`, `boxIn`, `lid` and the rest
 * without knowing anything about compositing, and this file never decides what
 * the user meant by a tap.
 *
 * Layer order, back to front, and each of them is here for a reason:
 *
 *   plate      the kitchen, with a flameless oven (see prepare-oven.mjs)
 *   fire       keyed flame frames, composited additively into the oven mouth
 *   spill      the light that fire throws into the room, tied to its brightness
 *   peel       the tool, which flicks as the pizza leaves and returns
 *   box base   slides in along the counter when an order is added
 *   shadow     drawn after the peel because at rest it falls *on* the blade
 *   pizza      motion-blurred along its own travel vector
 *   toppings   extras raining down and melting in
 *   box lid    drawn over the pizza, which is what closing a lid looks like
 */
import { PEEL_BLADE, PIZZA_DIAMETER, REST, flavorAt, poseAt, posesFor } from '../scene'
import type { Flavor, Plan, SpriteMeta } from '../scene'
import { FIRE, PLATE_IMAGE, PROPS } from '../props'

/** Everything the renderer needs decoded before it can draw a frame. */
export interface SceneAssets {
  plate: ImageBitmap
  peel: ImageBitmap
  /** Nine poses per flavour. A flavour still streaming in is simply absent. */
  poses: Record<Flavor, ImageBitmap[]>
  /** Flame frames, all the same size, base-aligned. Empty until they arrive. */
  flames: ImageBitmap[]
  /** The box in three states: lid up, lid halfway, lid shut. */
  boxOpen?: ImageBitmap
  boxMid?: ImageBitmap
  boxClosed?: ImageBitmap
  /** Individual pieces per extra, cut from one sheet each. */
  toppings: Record<string, ImageBitmap[]>
}

/**
 * The animated numbers. All of them are tweened from outside; none is derived
 * here, so a frame is a pure function of this object plus the clock.
 */
export interface SceneState {
  /** Toss timeline. Every whole number is a pizza at rest on the peel. */
  p: number
  /** Pizza size multiplier - the chosen size, tweened. */
  size: number
  /** 0 the box is off-stage right, 1 it is centred on the counter. */
  boxIn: number
  /** 0 lid open, 1 lid shut. Cross-dissolves open -> closed. */
  lid: number
  /** 0 the peel is under the pizza, 1 it has been pulled out of frame. */
  peelOut: number
  /** 1 hides the pizza - used while a shut lid is covering it anyway. */
  pizzaOut: number
  /** Whole-scene warm flash, for the moment an order is placed. */
  flash: number
}

export const initialState = (): SceneState => ({
  p: 0,
  size: 1,
  boxIn: 0,
  lid: 0,
  peelOut: 0,
  pizzaOut: 0,
  flash: 0,
})

// ------------------------------------------------------------- constants ---

const BLUR_STAMPS = 5
const BLUR_FLOOR = 12
const BLUR_REACH = 0.4
const BLUR_MAX = 26

const PEEL_WIDTH_RATIO = 1.04
const PEEL_DROP = 18

/**
 * Where the box sits when it is centred on the counter, in plate pixels.
 *
 * `width` is the base, and it is only a little wider than the 500px pizza -
 * which is what a box is. Wider than that and the pizza drops into something
 * that reads as a crate.
 */
const BOX = { x: REST.x, y: REST.y + 104, width: 545, offRight: 1200 }

/**
 * How fast the fire runs, in frames per second.
 *
 * Twelve, not sixty: the frames are separate renders of the same fire, and
 * played faster than the eye can resolve one from the next they stop reading as
 * one fire moving and start reading as noise. Consecutive frames are
 * cross-faded, so the motion between them stays continuous at this rate.
 */
const FIRE_FPS = 11

/**
 * The scene point aimed at a fraction of the screen height when the plate is
 * taller than the window. y=470 is the middle of the original kitchen.
 */
const FOCUS = { y: 470, at: 0.5 }

/** How far the pizza, peel and box are lifted on the narrowest screens. */
const LIFT_MAX = 90

/**
 * Topping pieces are stored at twice the size they are drawn.
 *
 * prepare-props.mjs cuts them at 2x on purpose - the plate is scaled up to
 * cover a big display, so a 38px olive is asked for at 80-odd real pixels on a
 * 4K screen and a 38px file would be visibly soft. Halving it here is the
 * other half of that bargain, and forgetting it is very obvious: the olives
 * come out the size of doughnuts.
 */
const PIECE_SCALE = 0.5

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** 1 below `a`, 0 above `b`, smooth between - `a` may be the larger. */
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

export class SceneRenderer {
  private ctx: CanvasRenderingContext2D
  /** Plate-space -> canvas transform, recomputed on resize. */
  private view = { k: 1, ox: 0, oy: 0 }
  /** Previous pizza centroid, in plate coordinates, for the blur vector. */
  private prev: { x: number; y: number } | null = null
  /** False while the frame on screen still carries motion blur. */
  settled = false
  private drops: Drop[] = []
  /** Smoothed fire brightness, 0..1 - drives the light spill. */
  private glow = 0.5
  /** Plate pixels the actors are raised by, to clear the dock on a phone. */
  private lift = 0
  private poseMeta: Record<Flavor, ReturnType<typeof posesFor>> = {}

  constructor(
    private canvas: HTMLCanvasElement,
    private assets: SceneAssets,
    private reduceMotion: boolean
  ) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
  }

  /** Pose metadata is cached per flavour on first use - it never changes. */
  private meta(flavor: Flavor) {
    return (this.poseMeta[flavor] ??= posesFor(flavor))
  }

  /**
   * Fits the plate to the stage.
   *
   * Cover, against the *bitmap* rather than against the scene: the portrait
   * plate is taller than the 1672x941 kitchen the scene is measured in, and
   * PLATE_IMAGE says where the scene's origin sits inside it. Scene y then
   * runs negative up into the ceiling that was added above.
   *
   * Which part of a too-tall plate to keep is decided by aiming one scene point
   * at one screen fraction - FOCUS - and then clamping so the bitmap never
   * pulls away from an edge. In landscape that lands the original kitchen
   * almost exactly in a 16:9 window, which is the framing it was rendered for.
   * In portrait there is nothing left to choose: the plate is exactly as tall
   * as it needs to be, the clamp takes over, and the whole picture is on
   * screen.
   */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 0
    const h = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 0
    if (!w || !h) return
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)

    const img = PLATE_IMAGE
    const cw = this.canvas.width
    const ch = this.canvas.height
    const k = Math.max(cw / img.width, ch / img.height)

    const imgX = (cw - img.width * k) / 2
    const wanted = ch * FOCUS.at - (FOCUS.y + img.top) * k
    const imgY = Math.min(0, Math.max(ch - img.height * k, wanted))

    this.view = { k, ox: imgX + img.left * k, oy: imgY + img.top * k }

    // On a narrow screen the dock covers the bottom third, and the pizza rests
    // low in the frame - low enough to sit behind it. Everything the visitor is
    // actually watching is lifted clear rather than the scene being zoomed out,
    // which would only crop more of it away. A peel held a little above the
    // counter is what someone holding a peel looks like, so nothing about the
    // scene stops making sense.
    const aspect = w / h
    this.lift = LIFT_MAX * smoothstep(0.95, 0.55, aspect)
    this.prev = null
  }

  /** Canvas pixels per plate pixel - for placing DOM over scene features. */
  get scale() {
    return this.view.k / (Math.min(window.devicePixelRatio || 1, 2) || 1)
  }

  /** Plate coordinates -> CSS pixels inside the stage. */
  toStage(x: number, y: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    return {
      x: (this.view.ox + x * this.view.k) / dpr,
      y: (this.view.oy + y * this.view.k) / dpr,
    }
  }

  /** Spawns a fall of one extra's pieces onto the pizza. */
  rain(extra: string, count = 11) {
    const pieces = this.assets.toppings[extra]
    if (!pieces?.length) return
    for (let i = 0; i < count; i++) {
      // Landing spots are spread over the pizza face by area, not by radius -
      // sampling the radius uniformly would bunch every topping in the middle.
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * PIZZA_DIAMETER * 0.4
      const bmp = pieces[(Math.random() * pieces.length) | 0]
      this.drops.push({
        bmp,
        tx: Math.cos(a) * r,
        ty: Math.sin(a) * r * 0.42,
        // Staggered so they arrive as a scatter rather than as one curtain.
        delay: Math.random() * 0.38,
        fall: 0,
        spin: (Math.random() - 0.5) * 2.4,
        rot: Math.random() * Math.PI * 2,
        scale: 0.82 + Math.random() * 0.36,
        t: 0,
      })
    }
  }

  get raining() {
    return this.drops.length > 0
  }

  clearRain() {
    this.drops.length = 0
  }

  /**
   * Draws one frame.
   *
   * `dt` advances the things that run on their own clock - the fire and the
   * falling toppings - while everything else comes from `s`, which something
   * else has already tweened to where it should be at this instant.
   */
  draw(s: SceneState, plan: Plan, dt: number, time: number) {
    const { ctx, view } = this
    const flavor = flavorAt(s.p, plan)
    const bitmaps = this.assets.poses[flavor]
    if (!bitmaps) return

    const pose = poseAt(s.p)
    const diameter = PIZZA_DIAMETER * s.size

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.setTransform(view.k, 0, 0, view.k, view.ox, view.oy)

    ctx.drawImage(
      this.assets.plate,
      -PLATE_IMAGE.left,
      -PLATE_IMAGE.top,
      PLATE_IMAGE.width,
      PLATE_IMAGE.height
    )

    // The fire belongs to the oven, so it stays with the plate. Everything
    // below is an actor standing in front of it, and rises together.
    this.drawFire(time)

    ctx.save()
    ctx.translate(0, -this.lift)
    this.drawBox(s, 'base')
    this.drawPeel(s, pose, diameter)
    if (s.pizzaOut < 1) {
      this.drawShadow(pose, diameter, s)
      this.drawPizza(pose, flavor, bitmaps, diameter)
      this.drawDrops(dt, pose, diameter)
    }
    this.drawBox(s, 'lid')
    ctx.restore()

    this.drawFlash(s)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
  }

  // ------------------------------------------------------------- layers ---

  /**
   * The fire, composited additively into the oven mouth.
   *
   * Additive rather than drawn over: the flames were keyed off magenta and
   * their edges are soft and semi-transparent, which is what fire actually
   * looks like - it *adds* light to what is behind it rather than hiding it.
   * `lighter` also means the black the sprites were bled to contributes
   * nothing, so WebP smearing a little colour past the flame edge is harmless.
   *
   * Two frames are always on screen, cross-faded, so the fire moves smoothly
   * between renders that are a tenth of a second apart.
   */
  private drawFire(time: number) {
    const { ctx } = this
    const frames = this.assets.flames
    if (!frames.length) return

    // Reduced motion holds a single frame: a fire that flickers is exactly the
    // kind of restless movement the preference is asking not to be shown, and
    // the oven still reads as lit because the frame it holds is a lit one.
    const f = this.reduceMotion ? 0 : time * FIRE_FPS
    const i = Math.floor(f) % frames.length
    const j = (i + 1) % frames.length
    const mix = this.reduceMotion ? 0 : f - Math.floor(f)

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // Both frames at full strength would double the light wherever they
    // overlap, so the cross-fade is weighted to sum to one.
    ctx.globalAlpha = 1 - mix
    ctx.drawImage(frames[i], FIRE.left, FIRE.top, FIRE.width, FIRE.height)
    if (mix > 0) {
      ctx.globalAlpha = mix
      ctx.drawImage(frames[j], FIRE.left, FIRE.top, FIRE.width, FIRE.height)
    }
    ctx.restore()

    // The room reacts to the fire. Without this the flames are a video playing
    // inside a photograph; with it the whole kitchen breathes at the same rate.
    const target = FIRE.brightness[i] * (1 - mix) + FIRE.brightness[j] * mix
    this.glow += (target - this.glow) * 0.25
    const lift = (this.glow - 0.5) * 2

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.max(0, 0.05 + 0.055 * lift)
    const cx = FIRE.left + FIRE.width / 2
    const cy = FIRE.top + FIRE.height * 0.7
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, PLATE_IMAGE.width * 0.5)
    g.addColorStop(0, 'rgba(255,150,54,1)')
    g.addColorStop(0.45, 'rgba(255,110,30,0.34)')
    g.addColorStop(1, 'rgba(255,90,20,0)')
    ctx.fillStyle = g
    ctx.fillRect(-PLATE_IMAGE.left, -PLATE_IMAGE.top, PLATE_IMAGE.width, PLATE_IMAGE.height)
    ctx.restore()
  }

  private drawPeel(s: SceneState, pose: ReturnType<typeof poseAt>, diameter: number) {
    if (s.peelOut >= 1) return
    const { ctx } = this
    const peelScale = (diameter * PEEL_WIDTH_RATIO) / PEEL_BLADE.width
    ctx.save()
    ctx.globalAlpha = 1 - s.peelOut
    // Retracting, the peel slides down and out the way a hand would pull it,
    // rather than fading on the spot.
    ctx.translate(pose.peel.x + 120 * s.peelOut, pose.peel.y + PEEL_DROP + 260 * s.peelOut)
    ctx.rotate(pose.peel.rotation)
    ctx.drawImage(
      this.assets.peel,
      -PEEL_BLADE.cx * peelScale,
      -PEEL_BLADE.cy * peelScale,
      this.assets.peel.width * peelScale,
      this.assets.peel.height * peelScale
    )
    ctx.restore()
  }

  private drawShadow(pose: ReturnType<typeof poseAt>, diameter: number, s: SceneState) {
    const a = pose.shadow.alpha * (1 - s.peelOut * 0.5)
    if (a <= 0.002) return
    const { ctx } = this
    const rx = (diameter / PIZZA_DIAMETER) * pose.shadow.rx
    const ry = (diameter / PIZZA_DIAMETER) * pose.shadow.ry
    const g = ctx.createRadialGradient(pose.shadow.x, pose.shadow.y, 0, pose.shadow.x, pose.shadow.y, 1)
    g.addColorStop(0, `rgba(0,0,0,${a})`)
    g.addColorStop(0.55, `rgba(0,0,0,${a * 0.62})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.save()
    ctx.translate(pose.shadow.x, pose.shadow.y)
    ctx.scale(rx, ry)
    ctx.fillStyle = g
    ctx.translate(-pose.shadow.x, -pose.shadow.y)
    ctx.fillRect(pose.shadow.x - 1, pose.shadow.y - 1, 2, 2)
    ctx.restore()
  }

  private drawPizza(
    pose: ReturnType<typeof poseAt>,
    flavor: Flavor,
    bitmaps: ImageBitmap[],
    diameter: number
  ) {
    const { ctx } = this
    const travel = this.prev ? Math.hypot(pose.x - this.prev.x, pose.y - this.prev.y) : 0
    const stamps = this.reduceMotion || travel < BLUR_FLOOR ? 1 : BLUR_STAMPS
    this.settled = stamps === 1
    const reach = travel > 0 ? Math.min(BLUR_REACH, BLUR_MAX / travel) : 0
    const vx = this.prev ? (pose.x - this.prev.x) * reach : 0
    const vy = this.prev ? (pose.y - this.prev.y) * reach : 0

    // A flavour that is still streaming in has only pose 1. Falling back to it
    // means an early tap cuts between flavours instead of tumbling, which is
    // the same thing reduced motion does - not a failure, just less of a show,
    // and the rest arrives within a second of the tap.
    const index = bitmaps[pose.index] ? pose.index : 0
    const meta = this.meta(flavor)[index].meta
    const bmp = bitmaps[index]
    const spriteScale = (diameter * pose.scale) / meta.major

    ctx.save()
    ctx.translate(pose.x, pose.y)
    ctx.scale(1, pose.squash)
    ctx.translate(-pose.x, -pose.y)

    // 1/(i+1) per stamp accumulates into a running mean of all of them - the
    // actual definition of motion blur, and opaque wherever they overlap. The
    // obvious 1/N is wrong: source-over converges on 1-(1-1/N)^N, about 63%,
    // which makes the pizza see-through the whole time it is moving.
    for (let i = 0; i < stamps; i++) {
      const o = stamps === 1 ? 0 : i / (stamps - 1) - 0.5
      ctx.globalAlpha = 1 / (i + 1)
      this.stamp(bmp, meta, pose.x - vx * o, pose.y - vy * o, spriteScale)
    }
    ctx.restore()
    ctx.globalAlpha = 1
    this.prev = { x: pose.x, y: pose.y }
  }

  private stamp(bmp: ImageBitmap, m: SpriteMeta, x: number, y: number, scale: number) {
    this.ctx.drawImage(
      bmp,
      x - m.cx * scale,
      y - m.cy * scale,
      bmp.width * scale,
      bmp.height * scale
    )
  }

  /**
   * Toppings falling onto the pizza.
   *
   * They land, settle, and melt in rather than staying put. Staying would mean
   * carrying them through the tumble, and a topping pinned to a pizza that is
   * rotating in three dimensions has to rotate with it - the poses are
   * photographs, not a model, so there is no axis to rotate about. Melting in
   * is also what actually happens to a topping dropped on a hot pizza.
   */
  private drawDrops(dt: number, pose: ReturnType<typeof poseAt>, diameter: number) {
    if (!this.drops.length) return
    const { ctx } = this
    const k = diameter / PIZZA_DIAMETER

    for (const d of this.drops) {
      d.t += dt
      const t = d.t - d.delay
      if (t < 0) continue

      // 0 -> 1 fall, then a short settle, then melt away.
      const FALL = 0.46
      const HOLD = 0.5
      const MELT = 0.55
      d.fall = Math.min(1, t / FALL)
      const landed = d.fall >= 1

      const ease = 1 - (1 - d.fall) * (1 - d.fall) // gravity-ish
      const x = pose.x + d.tx * k
      const y = pose.y + d.ty * k - (1 - ease) * 520
      const settle = landed ? Math.max(0, 1 - (t - FALL) / 0.22) : 0
      const melt = landed ? Math.max(0, (t - FALL - HOLD) / MELT) : 0
      if (melt >= 1) continue

      ctx.save()
      ctx.globalAlpha = 1 - melt
      ctx.translate(x, y)
      // Spin while falling, then stop dead on landing - a piece that keeps
      // turning after it has landed reads as sliding on ice.
      ctx.rotate(d.rot + d.spin * (1 - ease))
      // A squash on impact and a slight spread as it melts in.
      const sc = k * PIECE_SCALE * d.scale * (1 + 0.16 * melt)
      ctx.scale(sc, sc * (1 - 0.3 * settle))
      ctx.drawImage(d.bmp, -d.bmp.width / 2, -d.bmp.height / 2)
      ctx.restore()
    }

    // Reaping after drawing rather than during keeps the array stable while it
    // is being walked.
    this.drops = this.drops.filter((d) => d.t - d.delay < 0.46 + 0.5 + 0.55)
  }

  /**
   * The box, in two passes: its base behind the pizza, its closed form over it.
   *
   * Closing a lid over a pizza is exactly a cross-fade from the open box to the
   * closed one drawn *after* the pizza - as the closed box fades up it covers
   * the pizza, which is what a lid coming down does. No lid sprite has to
   * rotate, and the two boxes are the same box photographed twice, so nothing
   * shifts underneath the dissolve.
   */
  private drawBox(s: SceneState, pass: 'base' | 'lid') {
    const { boxOpen, boxMid, boxClosed } = this.assets
    if (!boxOpen || s.boxIn <= 0.001) return
    const { ctx } = this

    // Slides in from off-stage right, decelerating.
    const ease = 1 - Math.pow(1 - Math.min(1, s.boxIn), 3)
    const x = BOX.x + BOX.offRight * (1 - ease)
    const arriving = Math.min(1, s.boxIn * 3)

    /** Every state is the same width and stands on the same line. */
    const place = (bmp: ImageBitmap, alpha: number) => {
      if (alpha <= 0.002) return
      const k = BOX.width / bmp.width
      ctx.globalAlpha = arriving * alpha
      ctx.drawImage(bmp, x - (bmp.width * k) / 2, BOX.y - bmp.height * k, bmp.width * k, bmp.height * k)
    }

    ctx.save()
    if (pass === 'base') {
      // The open box, fading out as the lid comes down over it.
      place(boxOpen, 1)
    } else {
      // The lid closing, over the pizza - which is what shutting a lid does.
      //
      // Three photographs of the same box rather than two: the second take of
      // the closed box came back with the lid halfway down, and a dissolve
      // that passes through it reads as a lid falling. Straight from open to
      // shut reads as one box being swapped for another.
      const mid = boxMid ?? boxClosed
      if (s.lid <= 0) {
        // nothing over the pizza yet
      } else if (mid && s.lid < 0.5) {
        place(mid, s.lid * 2)
      } else if (mid && boxClosed) {
        place(mid, Math.max(0, 1 - (s.lid - 0.5) * 2))
        place(boxClosed, (s.lid - 0.5) * 2)
      } else if (boxClosed) {
        place(boxClosed, s.lid)
      }
    }
    ctx.restore()
  }

  /** A warm bloom over the whole scene, for the moment an order is placed. */
  private drawFlash(s: SceneState) {
    if (s.flash <= 0.001) return
    const { ctx } = this
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = s.flash * 0.3
    ctx.fillStyle = '#ffb14a'
    ctx.fillRect(-PLATE_IMAGE.left, -PLATE_IMAGE.top, PLATE_IMAGE.width, PLATE_IMAGE.height)
    ctx.restore()
  }
}

interface Drop {
  bmp: ImageBitmap
  /** Landing spot relative to the pizza centroid, in plate pixels. */
  tx: number
  ty: number
  delay: number
  fall: number
  spin: number
  rot: number
  scale: number
  t: number
}

export { BOX, PROPS }
