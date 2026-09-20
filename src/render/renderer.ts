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
 *   stack      boxes already ordered, and the sides, waiting further back
 *   peel       the tool, which flicks as the pizza leaves and returns
 *   shadow     drawn after the peel because at rest it falls *on* the blade
 *   pizza      motion-blurred along its own travel vector
 *   toppings   the extras, lying in the pizza's own plane
 *   box        the one being filled, nearest the camera of anything
 */
import { PEEL_BLADE, PIZZA_DIAMETER, REST, flavorAt, poseAt, posesFor } from '../scene'
import type { Flavor, Plan } from '../scene'
import { FIRE, PLATE_IMAGE, PROPS } from '../props'

/** Everything the renderer needs decoded before it can draw a frame. */
export interface SceneAssets {
  plate: ImageBitmap
  peel: ImageBitmap
  /** Nine poses per flavour. A flavour still streaming in is simply absent. */
  poses: Record<Flavor, ImageBitmap[]>
  /** Flame frames, all the same size, base-aligned. Empty until they arrive. */
  flames: ImageBitmap[]
  /**
   * The box closing, in order: lid up through to lid shut. All the same size
   * with the base registered to the same spot, so playing them moves nothing
   * but the lid.
   */
  boxFrames: ImageBitmap[]
  /** The upsell, standing on the counter beside the stack. */
  fries?: ImageBitmap
  cola?: ImageBitmap
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
  /** 0 the box is off-stage right, 1 it is on the counter under the pizza. */
  boxIn: number
  /** 0 lid up, 1 lid shut. Picks a frame; it does not cross-fade. */
  lid: number
  /** 0 the pizza is where it always lands, 1 it is down inside the box. */
  dropIn: number
  /** 0 the filled box is on the counter, 1 it has joined the stack behind. */
  boxAway: number
  /** Boxes already in the stack. Set directly, never tweened. */
  stack: number
  /** 0..1 the fries and the cola arriving beside the stack. */
  sides: number
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
  dropIn: 0,
  boxAway: 0,
  stack: 0,
  sides: 0,
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
 * Where the box sits while it is being filled, in plate pixels.
 *
 * `width` is the base, and it is only a little wider than the 500px pizza -
 * which is what a box is. Wider than that and the pizza drops into something
 * that reads as a crate.
 */
const BOX = { x: REST.x, y: REST.y + 104, width: 545, offRight: 1200 }

/**
 * Where the pizza ends up once it is lying in the box, and how big it is then.
 *
 * Lower and smaller than where it lands on the peel: the tray's floor is
 * further from the camera than the blade was, and a 12" pizza has to fit
 * between the tray's walls. Both are eased in over the last third of the toss,
 * so the pizza settles down into the box rather than landing beside it.
 */
const BOX_PIZZA = { y: 640, scale: 0.75 }

/**
 * Where finished boxes wait: the back of the counter, behind the glass.
 *
 * Smaller and higher in the frame than the box being filled, which is what
 * "further away on the same surface" looks like from this camera. They stay
 * there for the rest of the order, so what has been bought is on screen while
 * it is being paid for rather than only in a list.
 *
 * As far back as it is because of the phone. The order step opens the tallest
 * dock of the four, and anything on the near edge of the counter ends up
 * behind it - so the pile stands where a pile of finished boxes would stand
 * anyway, at the back, which is also the only part of the counter a phone can
 * still see at checkout.
 */
const STACK = { x: 1150, y: 566, width: 216, step: 31 }

/**
 * The fries and the cola, standing beside the stack.
 *
 * Everything here is kept inside x 930..1270, which is what a phone can see:
 * the visible window on a 390px screen runs from about 370 to 1300 in plate
 * pixels, and the pizza itself takes 590 to 1090 of it. This is the only
 * strip of counter left.
 */
const SIDES = {
  fries: { x: 968, y: 572, height: 124 },
  cola: { x: 1044, y: 576, height: 110 },
}

/**
 * How fast the fire runs, in frames per second.
 *
 * Eleven, not sixty: the frames are separate renders of the same fire, and
 * played faster than the eye can resolve one from the next they stop reading
 * as one fire moving and start reading as noise. Consecutive frames are
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
 * How far the pile and the sides slide right on a wide screen.
 *
 * A phone can only see the middle 930 plate pixels, so the pile has to stand
 * close in - which on a wide screen puts it in front of the oven mouth, over
 * the fire. There is a clear stretch of counter further right that only a wide
 * window can see, so on a wide window that is where it goes.
 */
const STAGING_SHIFT = 150

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

/** Seconds a topping takes to fall, and how long its landing squash lasts. */
const FALL = 0.46
const SETTLE = 0.22

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
  private pieces: Piece[] = []
  /** Smoothed fire brightness, 0..1 - drives the light spill. */
  private glow = 0.5
  /** Plate pixels the actors are raised by, to clear the dock on a phone. */
  private lift = 0
  /** Plate pixels the pile and the sides move right on a wide screen. */
  private staging = 0
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
   * almost exactly in a 16:9 window. In portrait there is nothing left to
   * choose: the plate is exactly as tall as it needs to be, the clamp takes
   * over, and the whole picture is on screen.
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
    const narrow = smoothstep(0.95, 0.55, aspect)
    this.lift = LIFT_MAX * narrow
    this.staging = STAGING_SHIFT * (1 - narrow)
    this.prev = null
  }

  /**
   * Scatters one extra's pieces onto the pizza.
   *
   * Positions are chosen in the pizza's **own** coordinates - a unit disc,
   * which is what a pizza is - not in screen pixels. Where that lands on screen
   * is worked out afresh every frame from whichever pose the pizza is in, so a
   * topping stays on the pizza through a toss instead of hanging in the air
   * where the pizza used to be.
   */
  rain(extra: string, count = 11) {
    const set = this.assets.toppings[extra]
    if (!set?.length) return
    for (let i = 0; i < count; i++) {
      // Sampled by area, not by radius: a uniform radius bunches every topping
      // in the middle. 0.78 keeps them off the crust.
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(Math.random()) * 0.78
      this.pieces.push({
        extra,
        bmp: set[(Math.random() * set.length) | 0],
        u: Math.cos(a) * r,
        v: Math.sin(a) * r,
        // Staggered so they arrive as a scatter rather than as one curtain.
        delay: Math.random() * 0.38,
        spin: (Math.random() - 0.5) * 2.4,
        rot: Math.random() * Math.PI * 2,
        scale: 0.82 + Math.random() * 0.36,
        t: 0,
      })
    }
  }

  /** Takes one extra's pieces off again, for an extra that was un-chosen. */
  unrain(extra: string) {
    this.pieces = this.pieces.filter((p) => p.extra !== extra)
  }

  /** Everything added to this pizza is gone; the next one starts bare. */
  clearToppings() {
    this.pieces.length = 0
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

    // Where the pizza actually is, which is not where the toss alone would put
    // it: over the last of the arc it is also settling down into the box.
    // Worked out once here because the shadow, the sprite and every topping
    // lying on it all have to agree about it.
    const place = {
      x: pose.x,
      y: pose.y + (BOX_PIZZA.y - REST.y) * s.dropIn,
      diameter: diameter * (1 - (1 - BOX_PIZZA.scale) * s.dropIn),
    }

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

    // What has already been ordered, waiting further back down the counter.
    //
    // Outside the lift: the lift exists to raise the pizza clear of the dock on
    // a phone, and these are already well above it. Lifting them too would take
    // them off the counter and leave them floating in front of the oven.
    this.drawStack(s)
    this.drawSides(s)

    ctx.save()
    ctx.translate(0, -this.lift)

    // The box in two passes, with the pizza between them - which is what being
    // *in* a box means. Behind: the lid standing up at the back, and the floor
    // of the tray. In front: the tray's near wall, which the pizza sinks
    // behind as it settles in.
    this.drawBox(s, 'back')
    this.drawPeel(s, pose, diameter)
    if (s.pizzaOut < 1) {
      this.drawShadow(pose, place, s)
      this.drawPizza(pose, place, flavor, bitmaps)
      this.drawToppings(dt, pose, place, flavor)
    }
    this.drawBox(s, 'front')
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

  private drawShadow(pose: ReturnType<typeof poseAt>, place: Place, s: SceneState) {
    // Gone by the time the pizza is in the box: that shadow falls on the
    // counter, and once the pizza is inside there is a cardboard floor a few
    // inches under it instead.
    const a = pose.shadow.alpha * (1 - s.peelOut * 0.5) * (1 - s.dropIn)
    if (a <= 0.002) return
    const { ctx } = this
    const rx = (place.diameter / PIZZA_DIAMETER) * pose.shadow.rx
    const ry = (place.diameter / PIZZA_DIAMETER) * pose.shadow.ry
    const g = ctx.createRadialGradient(
      pose.shadow.x,
      pose.shadow.y,
      0,
      pose.shadow.x,
      pose.shadow.y,
      1
    )
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
    place: Place,
    flavor: Flavor,
    bitmaps: ImageBitmap[]
  ) {
    const { ctx } = this
    const travel = this.prev ? Math.hypot(place.x - this.prev.x, place.y - this.prev.y) : 0
    const stamps = this.reduceMotion || travel < BLUR_FLOOR ? 1 : BLUR_STAMPS
    this.settled = stamps === 1
    const reach = travel > 0 ? Math.min(BLUR_REACH, BLUR_MAX / travel) : 0
    const vx = this.prev ? (place.x - this.prev.x) * reach : 0
    const vy = this.prev ? (place.y - this.prev.y) * reach : 0

    // A flavour that is still streaming in has only pose 1. Falling back to it
    // means an early tap cuts between flavours instead of tumbling, which is
    // the same thing reduced motion does - not a failure, just less of a show,
    // and the rest arrives within a second of the tap.
    const index = bitmaps[pose.index] ? pose.index : 0
    const meta = this.meta(flavor)[index].meta
    const bmp = bitmaps[index]
    // The bitmap is from whichever sprite set this screen was given, and the
    // measurements in sprite-data.json describe the standard one - so they are
    // scaled by what actually arrived. Everything else the renderer reads off
    // the metadata is either a ratio or an angle, and neither has a size.
    const ms = bmp.width / meta.width
    const spriteScale = (place.diameter * pose.scale) / (meta.major * ms)

    ctx.save()
    ctx.translate(place.x, place.y)
    ctx.scale(1, pose.squash)
    ctx.translate(-place.x, -place.y)

    // 1/(i+1) per stamp accumulates into a running mean of all of them - the
    // actual definition of motion blur, and opaque wherever they overlap. The
    // obvious 1/N is wrong: source-over converges on 1-(1-1/N)^N, about 63%,
    // which makes the pizza see-through the whole time it is moving.
    for (let i = 0; i < stamps; i++) {
      const o = stamps === 1 ? 0 : i / (stamps - 1) - 0.5
      ctx.globalAlpha = 1 / (i + 1)
      this.stamp(bmp, meta.cx * ms, meta.cy * ms, place.x - vx * o, place.y - vy * o, spriteScale)
    }
    ctx.restore()
    ctx.globalAlpha = 1
    this.prev = { x: place.x, y: place.y }
  }

  private stamp(bmp: ImageBitmap, cx: number, cy: number, x: number, y: number, scale: number) {
    this.ctx.drawImage(bmp, x - cx * scale, y - cy * scale, bmp.width * scale, bmp.height * scale)
  }

  /**
   * The extras, lying on the pizza.
   *
   * They stay. An earlier version faded them out a moment after they landed,
   * on the theory that they had melted in - which looked fine and was exactly
   * wrong, because the reason to watch a topping land is to see it on the pizza
   * you are about to buy, and again at checkout.
   *
   * Keeping them means projecting them properly. A pizza is a flat disc, and a
   * flat disc seen at an angle is an ellipse - and prepare-assets measures that
   * ellipse for every pose: both axes, and the direction of the long one. So a
   * topping is stored at a position on a unit disc, and each frame that
   * position is mapped onto whichever ellipse the pizza is currently showing.
   * The piece is squashed by the same minor/major it would be if it were lying
   * on that surface, which is what makes it read as *on* the pizza rather than
   * in front of it: near the top of the toss, where the pizza is nearly
   * edge-on, its toppings are nearly edge-on too.
   */
  private drawToppings(
    dt: number,
    pose: ReturnType<typeof poseAt>,
    place: Place,
    flavor: Flavor
  ) {
    if (!this.pieces.length) return
    const { ctx } = this

    const index = this.assets.poses[flavor]?.[pose.index] ? pose.index : 0
    const meta = this.meta(flavor)[index].meta
    const shown = place.diameter * pose.scale
    const rx = shown / 2
    // How flat the pizza is lying, from the camera's point of view.
    const squash = meta.minor / meta.major
    const ry = rx * squash
    const cos = Math.cos(meta.angle)
    const sin = Math.sin(meta.angle)
    const size = (shown / PIZZA_DIAMETER) * PIECE_SCALE

    ctx.save()
    ctx.translate(place.x, place.y)
    ctx.scale(1, pose.squash)
    ctx.translate(-place.x, -place.y)

    for (const piece of this.pieces) {
      piece.t += dt
      const t = piece.t - piece.delay
      if (t < 0) continue

      // Where on the pizza it belongs, wherever the pizza currently is.
      const ex = piece.u * rx
      const ey = piece.v * ry
      const x = place.x + ex * cos - ey * sin
      const y = place.y + ex * sin + ey * cos

      const falling = t < FALL
      // Gravity on the way down, then a squash on impact that settles out.
      const fall = falling ? 1 - (1 - t / FALL) * (1 - t / FALL) : 1
      const drop = falling ? (1 - fall) * 520 : 0
      const settle = Math.max(0, 1 - Math.max(0, t - FALL) / SETTLE)

      ctx.save()
      ctx.translate(x, y - drop)
      ctx.rotate(meta.angle)
      // Foreshorten first, then turn the piece within the pizza's own plane: a
      // topping lying on a tilted disc is squashed by the tilt, not by its own
      // rotation.
      ctx.scale(1, squash)
      // Still spinning while it falls, stopped dead once it lands - a piece
      // that keeps turning after it has landed reads as sliding on ice.
      ctx.rotate(piece.rot + piece.spin * (1 - fall))
      const s = size * piece.scale
      ctx.scale(s * (1 + 0.14 * settle), s * (1 - 0.24 * settle))
      ctx.drawImage(piece.bmp, -piece.bmp.width / 2, -piece.bmp.height / 2)
      ctx.restore()
    }

    ctx.restore()
  }

  /**
   * The box being filled, and its lid coming down.
   *
   * The lid is not a set of photographs. Two batches were generated of the same
   * box with its lid at a quarter, a third, a half and three quarters down, and
   * what came back each time was the lid still standing up or leaning off to
   * one side - from this camera a lid rotating about a hinge at the back mostly
   * foreshortens rather than sweeping, and that turns out to be a hard thing to
   * ask a generator for.
   *
   * So the in-between is computed. The open box is cut in two at the hinge -
   * measured off the art by prepare-props, where the silhouette stops being lid
   * and starts being base - the base is drawn where it always is, and the lid is
   * drawn above it squashed towards the hinge by `cos`. That is exactly what the
   * projection of a rotating lid does, and unlike a generated frame it can be
   * put at any angle at any moment.
   *
   * The shut box then fades in over the last of the fall. It has to: a lid
   * squashed to nothing is a line across the back of the box, where a shut box
   * is a lid lying over the whole base. Both carry the same logo, so the blend
   * reads as the lid arriving rather than as a dissolve.
   *
   * Once shut, the box travels back along the counter to the stack - shrinking
   * as it goes, because that is what moving away from a camera does - and
   * `boxAway` is that journey.
   */
  private drawBox(s: SceneState, pass: 'back' | 'front') {
    const frames = this.assets.boxFrames
    if (!frames.length || s.boxIn <= 0.001) return
    const { ctx } = this

    // Slides in from off-stage right, decelerating.
    const arrive = 1 - Math.pow(1 - Math.min(1, s.boxIn), 3)
    const fromX = BOX.x + BOX.offRight * (1 - arrive)

    // ...then away to the stack, where it is smaller and higher in the frame.
    const away = s.boxAway
    const slot = this.stackSlot(s.stack)
    const x = fromX + (slot.x - fromX) * away
    const y = BOX.y + (slot.y - BOX.y) * away
    const width = BOX.width + (STACK.width - BOX.width) * away

    const open = frames[0]
    const shut = frames[frames.length - 1]
    const k = width / open.width
    const left = x - (open.width * k) / 2
    const top = y - open.height * k
    // Both frames share one canvas with the base registered, so one hinge and
    // one scale serve both.
    const hinge = Math.round(PROPS.box.hinge * open.height)
    const front = Math.round(PROPS.box.front * open.height)
    const hingeY = top + hinge * k

    const arriving = Math.min(1, s.boxIn * 3)
    const shutIn = smoothstep(0.55, 1, s.lid)

    ctx.save()
    ctx.globalAlpha = arriving

    if (pass === 'back') {
      // The floor of the tray, which the pizza comes down onto.
      ctx.drawImage(
        open,
        0,
        hinge,
        open.width,
        front - hinge,
        left,
        hingeY,
        open.width * k,
        (front - hinge) * k
      )

      // The lid, standing at the back and falling towards the hinge.
      const fall = Math.cos(Math.min(1, s.lid) * (Math.PI / 2))
      const lidHeight = hinge * k * fall
      if (lidHeight > 0.5 && shutIn < 1) {
        ctx.globalAlpha = arriving * (1 - shutIn)
        ctx.drawImage(
          open,
          0,
          0,
          open.width,
          hinge,
          left,
          hingeY - lidHeight,
          open.width * k,
          lidHeight
        )
      }
    } else {
      // The near wall of the tray, in front of everything in the box.
      ctx.drawImage(
        open,
        0,
        front,
        open.width,
        open.height - front,
        left,
        top + front * k,
        open.width * k,
        (open.height - front) * k
      )

      // And the box shut, over the pizza and over its own near wall.
      if (shutIn > 0.001 && shut !== open) {
        ctx.globalAlpha = arriving * shutIn
        ctx.drawImage(shut, left, top, shut.width * k, shut.height * k)
      }
    }

    ctx.restore()
  }

  /** Where the nth box in the stack stands. */
  private stackSlot(n: number) {
    return { x: STACK.x + this.staging, y: STACK.y - n * STACK.step }
  }

  /** Boxes already ordered, waiting on the counter behind the pizza. */
  private drawStack(s: SceneState) {
    const frames = this.assets.boxFrames
    if (!frames.length || s.stack <= 0) return
    const { ctx } = this
    const shut = frames[frames.length - 1]
    const k = STACK.width / shut.width

    // Bottom of the pile first, so each box overlaps the one under it the way
    // a stack does.
    for (let n = 0; n < s.stack; n++) {
      const slot = this.stackSlot(n)
      ctx.drawImage(
        shut,
        slot.x - (shut.width * k) / 2,
        slot.y - shut.height * k,
        shut.width * k,
        shut.height * k
      )
    }
  }

  /** The fries and the cola, set down beside the stack when they are added. */
  private drawSides(s: SceneState) {
    if (s.sides <= 0.001) return
    const { ctx } = this

    const place = (
      bmp: ImageBitmap | undefined,
      at: { x: number; y: number; height: number },
      delay: number
    ) => {
      if (!bmp) return
      // One lands a moment after the other, so they arrive as two things being
      // set down rather than as one sprite appearing.
      const t = clamp01((s.sides - delay) / (1 - delay))
      if (t <= 0) return
      const ease = 1 - Math.pow(1 - t, 3)
      const k = at.height / bmp.height
      ctx.save()
      ctx.globalAlpha = t
      ctx.drawImage(
        bmp,
        at.x + this.staging - (bmp.width * k) / 2,
        at.y - bmp.height * k - (1 - ease) * 90,
        bmp.width * k,
        bmp.height * k
      )
      ctx.restore()
    }

    place(this.assets.fries, SIDES.fries, 0)
    place(this.assets.cola, SIDES.cola, 0.25)
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

/** Where the pizza is being drawn this frame, and how big. */
interface Place {
  x: number
  y: number
  diameter: number
}

interface Piece {
  /** Which extra it came from, so un-choosing one can take its pieces off. */
  extra: string
  bmp: ImageBitmap
  /** Where it lies on the pizza's own unit disc. */
  u: number
  v: number
  delay: number
  spin: number
  rot: number
  scale: number
  t: number
}

export { BOX, STACK, SIDES }
