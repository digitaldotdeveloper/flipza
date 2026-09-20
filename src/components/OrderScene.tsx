import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { FLAVORS, POSE_COUNT, labelFor } from '../scene'
import type { Flavor, Plan } from '../scene'
import { DEFAULT_SIZE, describeLine, fulfilmentById, money, orderCount, sizeById, unitPrice } from '../menu'
import type { OrderLine } from '../menu'
import { asset } from '../assets'
import { SceneRenderer, initialState } from '../render/renderer'
import type { SceneState } from '../render/renderer'
import { loadScene } from '../render/loader'
import type { LoadHandle } from '../render/loader'
import Dock, { STEPS } from './Dock'
import type { Ctl, Draft, Step } from './Dock'
import Placed from './Placed'

/**
 * Seconds one complete toss takes. A chained toss - choosing again while the
 * pizza is still in the air - covers more than one turn and takes
 * proportionally longer, with a floor so a small correction still reads as a
 * throw rather than a twitch.
 */
const FLIP_DURATION = 0.62
const MIN_DURATION_SHARE = 0.45

const params = new URLSearchParams(window.location.search)

/** `?slow=4` stretches every toss by that factor, for looking at a pose. */
const SLOW = (() => {
  const q = Number(params.get('slow'))
  return Number.isFinite(q) && q > 0 ? Math.min(q, 20) : 1
})()

/**
 * `?motion=on` animates even when the OS asks for reduced motion.
 *
 * Worth knowing before assuming the site is broken: **Windows Server has "Show
 * animations in Windows" off by default**, which Chrome reports as
 * `prefers-reduced-motion: reduce` - so the pizza cuts between flavours, the
 * fire holds on one frame, and the whole point of the site silently
 * disappears. It is not a rare preference on these machines, it is the default.
 *
 * Honouring it stays the default, because a full-screen tumble is exactly what
 * someone setting that preference is asking not to be shown.
 *
 * Beware when testing: Playwright overrides the media query to `no-preference`
 * by default, so an automated browser animates happily while the real one next
 * to it does not. Pass `reducedMotion: 'no-override'` to see the truth.
 */
const FORCE_MOTION = params.get('motion') === 'on' || params.has('slow')

let lineSeq = 0

export default function OrderScene() {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engine = useRef<Engine | null>(null)
  /** The streaming loader, kept so steps can pull their assets forward. */
  const loadHandle = useRef<LoadHandle | null>(null)

  const [progress, setProgress] = useState(0)
  const [ready, setReady] = useState(false)
  const [touched, setTouched] = useState(false)

  const [step, setStep] = useState<Step>('flavour')
  const [draft, setDraft] = useState<Draft>({
    flavor: FLAVORS[0],
    size: DEFAULT_SIZE.id,
    extras: [],
  })
  const [lines, setLines] = useState<OrderLine[]>([])
  /** Meals - fries and a cola - added alongside the pizzas. */
  const [meals, setMeals] = useState(0)
  /** Whether the upsell has been answered, either way, for this order. */
  const [askedMeal, setAskedMeal] = useState(false)
  const [fulfilment, setFulfilment] = useState('delivery')
  const [busy, setBusy] = useState(false)
  const [placed, setPlaced] = useState<{
    lines: OrderLine[]
    fulfilment: string
    meals: number
  } | null>(null)
  /** What the readout shows - follows the pizza, so it turns over mid-air. */
  const [shown, setShown] = useState<Flavor>(FLAVORS[0])

  /**
   * The draft, readable from callbacks that outlive the render they were made
   * in - a topping that finishes streaming after the tap has to know whether
   * it is still wanted.
   */
  const draftRef = useRef(draft)
  draftRef.current = draft

  // ------------------------------------------------------------- engine ---

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return

    const reduceMotion =
      !FORCE_MOTION && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let handle: LoadHandle | null = null
    let disposed = false
    let tick: ((time: number, delta: number) => void) | null = null

    const start = async () => {
      handle = await loadScene((done, total) => setProgress(done / total))
      if (disposed) return
      loadHandle.current = handle

      const renderer = new SceneRenderer(canvas, handle.assets, reduceMotion)
      const state = initialState()
      const plan: Plan = [FLAVORS[0]]
      let lastShown: Flavor = FLAVORS[0]
      /** Timeline position the running tween is aiming at, null when at rest. */
      let heading: number | null = null

      const resize = () => renderer.resize()
      const observer = new ResizeObserver(resize)
      observer.observe(stage)
      resize()

      tick = (time, delta) => {
        renderer.draw(state, plan, Math.min(delta / 1000, 0.05), time)
        const flavor = plan[Math.min(Math.floor(state.p + 0.625), plan.length - 1)]
        if (flavor !== lastShown) {
          lastShown = flavor
          setShown(flavor)
        }
      }
      gsap.ticker.add(tick)

      const tossTo = (target: number, from: number) =>
        gsap.to(state, {
          p: target,
          // Linear, deliberately: the arc supplies the gravity and the poses
          // supply the spin, both of which want a constant rate of time.
          ease: 'none',
          duration: reduceMotion
            ? 0
            : SLOW * FLIP_DURATION * Math.max(MIN_DURATION_SHARE, target - from),
          overwrite: 'auto',
          onComplete: () => {
            heading = null
          },
        })

      engine.current = {
        state,
        renderer,
        flipTo(flavor) {
          void handle?.ensure(flavor)
          const p = state.p
          const cycle = Math.floor(p)
          const t = p - cycle
          const atRest = heading === null

          // What the pizza is already going to end up as. Choosing that again
          // is not a toss, it is a no-op.
          const destined = atRest ? plan[cycle] : plan[cycle + 1]
          if (flavor === destined) return

          let target: number
          if (!atRest && t < 0.375) {
            // Still showing the old flavour - the toss already in the air can
            // simply be re-aimed. No extra tumble, and it never stutters.
            plan[cycle + 1] = flavor
            target = cycle + 1
          } else {
            target = atRest ? cycle + 1 : cycle + 2
            while (plan.length <= target) plan.push(plan[plan.length - 1])
            plan[target] = flavor
          }
          if (heading === target) return
          heading = target
          tossTo(target, p)
        },
        /**
         * One unprompted toss shortly after load.
         *
         * A site with nothing to scroll has no affordance at all - there is no
         * way to tell it does anything. Six hundred milliseconds of tumble
         * teaches the whole interaction better than the words underneath it,
         * and it lands on the same flavour it left with, so it costs the
         * visitor nothing and changes nothing they chose.
         */
        demo() {
          if (reduceMotion || heading !== null) return
          const cycle = Math.floor(state.p)
          const target = cycle + 1
          while (plan.length <= target) plan.push(plan[plan.length - 1])
          heading = target
          tossTo(target, state.p)
        },
        size(scale) {
          gsap.to(state, {
            size: scale,
            duration: reduceMotion ? 0 : 0.52,
            ease: 'back.out(1.6)',
            overwrite: true,
          })
        },
        rain(extra) {
          renderer.rain(extra)
        },
        unrain(extra) {
          renderer.unrain(extra)
        },
        /**
         * The pizza goes in a box.
         *
         * The one moment in the flow that is worth watching, so it is a
         * sequence rather than a state change: the box slides in along the
         * counter, the peel is pulled out from under the pizza, the pizza
         * tosses one more time and drops in, the lid closes over it and the box
         * leaves to the right. Nothing here is decorative - each beat is the
         * physical version of a step the order just took.
         */
        addToOrder() {
          if (reduceMotion) {
            // The whole sequence is motion, so under reduce there is nothing to
            // show. Land the pizza, put the box on the pile, and let the order
            // list do the talking.
            const cycle = Math.floor(state.p) + 1
            while (plan.length <= cycle) plan.push(plan[plan.length - 1])
            state.p = cycle
            state.stack += 1
            renderer.clearToppings()
            return Promise.resolve()
          }
          const cycle = Math.floor(state.p)
          const target = cycle + 1
          while (plan.length <= target) plan.push(plan[plan.length - 1])
          heading = target
          return new Promise<void>((resolve) => {
            gsap
              .timeline({
                onComplete: () => {
                  heading = null
                  resolve()
                },
              })
              // The box arrives while the pizza is still in the air.
              .to(state, { boxIn: 1, duration: 0.52, ease: 'power2.out' }, 0)
              .to(state, { peelOut: 1, duration: 0.4, ease: 'power2.inOut' }, 0.1)
              .to(state, { p: target, duration: 0.66, ease: 'none' }, 0.16)
              // The last of the arc is also a descent: over these four tenths
              // of a second the pizza stops heading for the spot it always
              // lands on and heads for the floor of the tray instead, shrinking
              // as it goes because the tray floor is further from the camera.
              // Eased *in*, so it drops rather than drifts.
              .to(state, { dropIn: 1, duration: 0.4, ease: 'power2.in' }, 0.58)
              // Then nothing at all for four tenths of a second.
              //
              // This is the whole point of the sequence and it used to be
              // twenty milliseconds long: the lid started falling the instant
              // the pizza touched down, so the one frame worth watching - the
              // pizza you just built, lying in an open box - was never
              // actually on screen. A beat of stillness is the animation.
              .to(state, { lid: 1, duration: 0.46, ease: 'power2.in' }, 1.42)
              // Hidden under a shut lid, so this is free - and it has to happen
              // before the box travels, or the pizza would stay behind on the
              // counter while its box left without it.
              .set(state, { pizzaOut: 1 }, 1.9)
              // Back down the counter to the pile, getting smaller as it goes.
              .to(state, { boxAway: 1, duration: 0.6, ease: 'power2.inOut' }, 1.96)
              .add(() => {
                // The travelling box lands exactly on the next free slot, so
                // handing it over to the pile changes nothing on screen.
                state.stack += 1
                state.boxIn = 0
                state.boxAway = 0
                state.lid = 0
                state.dropIn = 0
                state.pizzaOut = 0
                renderer.clearToppings()
              }, 2.56)
              .to(state, { peelOut: 0, duration: 0.42, ease: 'power2.out' }, 2.58)
          })
        },
        /** The fries and the cola, set down beside the pile. */
        addMeal() {
          gsap.to(state, {
            sides: 1,
            duration: reduceMotion ? 0 : 0.7,
            ease: 'power2.out',
            overwrite: true,
          })
        },
        flash() {
          if (reduceMotion) return Promise.resolve()
          return new Promise<void>((resolve) => {
            gsap
              .timeline({ onComplete: resolve })
              .to(state, { flash: 1, duration: 0.14, ease: 'power2.out' })
              .to(state, { flash: 0, duration: 0.7, ease: 'power2.in' })
          })
        },
        reset() {
          gsap.killTweensOf(state)
          Object.assign(state, initialState(), { p: Math.round(state.p) })
          heading = null
          renderer.clearToppings()
        },
      }

      setReady(true)
      // A handle on the scene for the screenshot harness and the console. Dev
      // only: it exists to answer "what does the renderer actually think is on
      // the pizza", which is not a question a shipped page needs to answer.
      if (import.meta.env.DEV) {
        ;(window as unknown as { __flipza?: unknown }).__flipza = {
          state,
          plan,
          renderer,
          assets: handle.assets,
        }
      }
      void handle.complete.catch((err) => console.error('[flipza] stream', err))

      return () => {
        observer.disconnect()
      }
    }

    let cleanupResize: (() => void) | undefined
    void start()
      .then((fn) => {
        cleanupResize = fn
      })
      .catch((err) => console.error('[flipza]', err))

    return () => {
      disposed = true
      engine.current = null
      loadHandle.current = null
      if (tick) gsap.ticker.remove(tick)
      cleanupResize?.()
      handle?.cancel()
    }
  }, [])

  /** One toss on load, so the page shows what it does before being asked. */
  useEffect(() => {
    if (!ready || touched) return
    const t = window.setTimeout(() => engine.current?.demo(), 1100)
    return () => window.clearTimeout(t)
  }, [ready, touched])

  // -------------------------------------------------------------- order ---

  const go = useCallback((next: Step) => {
    setTouched(true)
    setStep(next)
    // Opening the extras step is the earliest warning that the pieces and the
    // box are about to be needed, and it is a tap or two of notice.
    if (next === 'extras') {
      void loadHandle.current?.ensureToppings()
      void loadHandle.current?.ensureProps()
    }
  }, [])

  const chooseFlavor = useCallback((flavor: Flavor) => {
    setTouched(true)
    setDraft((d) => ({ ...d, flavor }))
    engine.current?.flipTo(flavor)
  }, [])

  const chooseSize = useCallback((id: string) => {
    setTouched(true)
    setDraft((d) => ({ ...d, size: id }))
    engine.current?.size(sizeById(id).scale)
  }, [])

  const toggleExtra = useCallback((id: string) => {
    setTouched(true)
    const on = draftRef.current.extras.includes(id)
    setDraft((d) => ({
      ...d,
      extras: on ? d.extras.filter((e) => e !== id) : [...d.extras, id],
    }))

    // Deliberately outside the updater above. React calls a state updater
    // twice in development to catch impure ones, and an updater that also
    // starts an animation duly starts it twice - which showed up as double
    // toppings and was very easy to miss.
    if (on) {
      // The pieces stay on the pizza once they land, so un-choosing an extra
      // has to take them off again - otherwise the pizza would keep wearing
      // something that is no longer being paid for.
      engine.current?.unrain(id)
      return
    }
    // The extras step can be reached before the topping pieces have streamed
    // in. Waiting on them rather than giving up means the first tap always
    // does something; if it has been un-chosen again by the time they arrive,
    // nothing falls.
    void loadHandle.current?.ensureToppings().then(() => {
      if (draftRef.current.extras.includes(id)) engine.current?.rain(id)
    })
  }, [])

  const addToOrder = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setTouched(true)
    const line: OrderLine = { id: `l${++lineSeq}`, ...draft, qty: 1 }
    // The box is the whole point of this sequence, and on a cold connection it
    // may still be in flight. Waiting on it is a beat of nothing; running
    // without it is a pizza that vanishes into thin air.
    await loadHandle.current?.ensureProps()
    await engine.current?.addToOrder()
    setLines((ls) => {
      // Same pizza twice is a quantity, not a second line.
      const match = ls.find(
        (l) =>
          l.flavor === line.flavor &&
          l.size === line.size &&
          l.extras.length === line.extras.length &&
          l.extras.every((e) => line.extras.includes(e))
      )
      if (match) return ls.map((l) => (l === match ? { ...l, qty: l.qty + 1 } : l))
      return [...ls, line]
    })
    setDraft((d) => ({ ...d, extras: [] }))
    setBusy(false)
    setStep('order')
  }, [busy, draft])

  const addMeal = useCallback(() => {
    setMeals((m) => m + 1)
    setAskedMeal(true)
    engine.current?.addMeal()
  }, [])

  const declineMeal = useCallback(() => setAskedMeal(true), [])

  const setQty = useCallback((id: string, qty: number) => {
    // The meal is not a line, it is a count - there is only one of it and it
    // has no options, so it does not need an id, a flavour or a size.
    if (id === 'meal') {
      setMeals(Math.max(0, qty))
      return
    }
    setLines((ls) =>
      qty <= 0 ? ls.filter((l) => l.id !== id) : ls.map((l) => (l.id === id ? { ...l, qty } : l))
    )
  }, [])

  const place = useCallback(async () => {
    if (!lines.length || busy) return
    setBusy(true)
    await engine.current?.flash()
    setPlaced({ lines, fulfilment, meals })
    setBusy(false)
  }, [lines, fulfilment, meals, busy])

  const startOver = useCallback(() => {
    setPlaced(null)
    setLines([])
    setMeals(0)
    setAskedMeal(false)
    setDraft({ flavor: FLAVORS[0], size: DEFAULT_SIZE.id, extras: [] })
    setStep('flavour')
    engine.current?.reset()
  }, [])

  const ctl: Ctl = useMemo(
    () => ({
      step,
      draft,
      lines,
      meals,
      askedMeal,
      fulfilment,
      busy,
      go,
      chooseFlavor,
      chooseSize,
      toggleExtra,
      addToOrder,
      addMeal,
      declineMeal,
      setQty,
      setFulfilment,
      place,
    }),
    [
      step,
      draft,
      lines,
      meals,
      askedMeal,
      fulfilment,
      busy,
      go,
      chooseFlavor,
      chooseSize,
      toggleExtra,
      addToOrder,
      addMeal,
      declineMeal,
      setQty,
      place,
    ]
  )

  const count = orderCount(lines)
  const pct = Math.round(progress * 100)

  return (
    <section className="hero" data-step={step}>
      <div ref={stageRef} className="hero__stage">
        <canvas ref={canvasRef} className="hero__canvas" />
        <div className="hero__scrim" aria-hidden="true" />

        <header className="hero__top">
          <img className="hero__logo" src={asset('logo.webp')} alt="Flipza Pizza" />
          <button
            type="button"
            className="basket"
            data-full={count > 0 || undefined}
            onClick={() => go('order')}
            aria-label={`Your order, ${count} pizza${count === 1 ? '' : 's'}`}
          >
            <span className="basket__n">{count}</span>
            <span className="basket__label">
              {count ? money(lines.reduce((s, l) => s + unitPrice(l) * l.qty, 0)) : 'Order'}
            </span>
          </button>
        </header>

        <div className="readout">
          <span className="readout__eyebrow">
            {step === 'order' ? 'Your order' : 'Now flipping'}
          </span>
          <span key={shown} className="readout__word">
            {labelFor(shown)}
          </span>
          <span className="readout__sub">
            {step === 'order' && lines.length
              ? `${count} pizza${count === 1 ? '' : 's'} · ${fulfilmentById(fulfilment).eta}`
              : `${sizeById(draft.size).inches} · ${money(unitPrice(draft))}`}
          </span>
        </div>

        {!touched && ready && <span className="hero__hint">Tap a flavour</span>}
      </div>

      <Dock ctl={ctl} />

      {placed && (
        <Placed
          lines={placed.lines}
          fulfilment={placed.fulfilment}
          meals={placed.meals}
          onDone={startOver}
        />
      )}

      <div className="loader" data-done={ready || undefined}>
        <img className="loader__logo" src={asset('logo.webp')} alt="Flipza Pizza" />
        <div className="loader__bar">
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
        <span className="loader__pct">{pct}%</span>
      </div>
    </section>
  )
}

interface Engine {
  state: SceneState
  renderer: SceneRenderer
  flipTo(flavor: Flavor): void
  demo(): void
  size(scale: number): void
  rain(extra: string): void
  unrain(extra: string): void
  addToOrder(): Promise<void>
  addMeal(): void
  flash(): Promise<void>
  reset(): void
}

export { POSE_COUNT, describeLine, STEPS }
