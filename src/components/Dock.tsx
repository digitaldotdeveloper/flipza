/**
 * The dock: the step rail, the sliding option panels and the one button that
 * moves the order forward.
 *
 * Presentational on purpose - it holds no order state and starts no animation.
 * Everything it can do arrives as `ctl` from OrderScene, which is also what
 * drives the canvas, so a tap can never put the buttons and the pizza into
 * different states.
 *
 * The panels are one track translated sideways rather than a swap of the
 * visible panel: sliding is the whole point of a stepper you never scroll, and
 * keeping all four mounted means the browser is not laying out a new panel in
 * the same frame it is animating the last one out.
 */
import { EXTRAS, MENU, SIZES, grandTotal, money, unitPrice } from '../menu'
import type { OrderLine } from '../menu'
import type { Flavor } from '../scene'
import OrderList from './OrderList'

export type Step = 'flavour' | 'size' | 'extras' | 'order'

export const STEPS: Step[] = ['flavour', 'size', 'extras', 'order']

export interface Draft {
  flavor: Flavor
  size: string
  extras: string[]
}

export interface Ctl {
  step: Step
  draft: Draft
  lines: OrderLine[]
  /** Meals - fries and a cola - on the order. */
  meals: number
  /** Whether the meal has been offered and answered, either way. */
  askedMeal: boolean
  fulfilment: string
  busy: boolean
  go(step: Step): void
  chooseFlavor(f: Flavor): void
  chooseSize(id: string): void
  toggleExtra(id: string): void
  addToOrder(): void
  addMeal(): void
  declineMeal(): void
  setQty(lineId: string, qty: number): void
  setFulfilment(id: string): void
  place(): void
}

const STEP_LABEL: Record<Step, string> = {
  flavour: 'Flavour',
  size: 'Size',
  extras: 'Extras',
  order: 'Order',
}

export default function Dock({ ctl }: { ctl: Ctl }) {
  const index = STEPS.indexOf(ctl.step)
  const unit = unitPrice(ctl.draft)

  return (
    <div className="dock" data-busy={ctl.busy || undefined}>
      <div className="rail" role="tablist" aria-label="Order steps">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            role="tab"
            className="rail__step"
            aria-selected={s === ctl.step}
            data-state={i === index ? 'now' : i < index ? 'done' : 'todo'}
            // Steps behind the current one are how you go back; steps ahead are
            // reachable too, because nothing downstream depends on having read
            // the ones in between - a size and two extras are already chosen.
            onClick={() => ctl.go(s)}
          >
            <span className="rail__dot">{i + 1}</span>
            <span className="rail__label">{STEP_LABEL[s]}</span>
          </button>
        ))}
      </div>

      <div className="dock__window">
        <div className="dock__track" style={{ transform: `translateX(${-index * 100}%)` }}>
          {/* ------------------------------------------------- flavour --- */}
          <section className="panel" aria-hidden={ctl.step !== 'flavour'}>
            <div className="chips chips--flavour">
              {MENU.map((m) => (
                <button
                  key={m.flavor}
                  type="button"
                  className="chip"
                  data-on={m.flavor === ctl.draft.flavor || undefined}
                  tabIndex={ctl.step === 'flavour' ? 0 : -1}
                  onClick={() => ctl.chooseFlavor(m.flavor)}
                >
                  <span className="chip__name">{m.label}</span>
                  <span className="chip__note">{money(m.price)}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ---------------------------------------------------- size --- */}
          <section className="panel" aria-hidden={ctl.step !== 'size'}>
            <div className="chips chips--size">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="chip chip--size"
                  data-on={s.id === ctl.draft.size || undefined}
                  tabIndex={ctl.step === 'size' ? 0 : -1}
                  onClick={() => ctl.chooseSize(s.id)}
                >
                  <span className="chip__size">{s.inches}</span>
                  <span className="chip__name">{s.label}</span>
                  <span className="chip__note">
                    {s.surcharge ? `+${money(s.surcharge)}` : 'included'}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* -------------------------------------------------- extras --- */}
          <section className="panel" aria-hidden={ctl.step !== 'extras'}>
            <div className="chips chips--extras">
              {EXTRAS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="chip"
                  data-on={ctl.draft.extras.includes(e.id) || undefined}
                  tabIndex={ctl.step === 'extras' ? 0 : -1}
                  onClick={() => ctl.toggleExtra(e.id)}
                >
                  <span className="chip__name">{e.label}</span>
                  <span className="chip__note">+{money(e.price)}</span>
                </button>
              ))}
            </div>
          </section>

          {/* --------------------------------------------------- order --- */}
          <section className="panel panel--order" aria-hidden={ctl.step !== 'order'}>
            <OrderList ctl={ctl} />
          </section>
        </div>
      </div>

      {/* One button, whose job changes with the step. Its price is always the
          price of what pressing it commits to, never a running total of
          something else. */}
      <div className="dock__cta">
        {ctl.step === 'flavour' && (
          <button type="button" className="cta" onClick={() => ctl.go('size')}>
            <span>Choose size</span>
            <span className="cta__price">{money(unit)}</span>
          </button>
        )}
        {ctl.step === 'size' && (
          <button type="button" className="cta" onClick={() => ctl.go('extras')}>
            <span>Add extras</span>
            <span className="cta__price">{money(unit)}</span>
          </button>
        )}
        {ctl.step === 'extras' && (
          <button
            type="button"
            className="cta cta--go"
            disabled={ctl.busy}
            onClick={() => ctl.addToOrder()}
          >
            <span>Add to order</span>
            <span className="cta__price">{money(unit)}</span>
          </button>
        )}
        {ctl.step === 'order' && (
          <button
            type="button"
            className="cta cta--go"
            disabled={(!ctl.lines.length && !ctl.meals) || ctl.busy}
            onClick={() => ctl.place()}
          >
            <span>Place order</span>
            <span className="cta__price">
              {money(grandTotal(ctl.lines, ctl.fulfilment, ctl.meals))}
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
