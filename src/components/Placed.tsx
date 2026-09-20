/**
 * The end of the flow: what was ordered, what it cost, when it arrives.
 *
 * Deliberately a panel over the kitchen rather than a page of its own - the
 * oven is still burning behind it, which is the only thing on the site that
 * says an order is now somebody's job. There is nothing to pay for here; this
 * is a storefront demo, and pretending to take a card would be the one
 * dishonest thing in it.
 */
import {
  MEAL,
  describeLine,
  fulfilmentById,
  grandTotal,
  linePrice,
  mealTotal,
  money,
  orderCount,
} from '../menu'
import type { OrderLine } from '../menu'

export default function Placed({
  lines,
  fulfilment,
  meals,
  onDone,
}: {
  lines: OrderLine[]
  fulfilment: string
  meals: number
  onDone: () => void
}) {
  const f = fulfilmentById(fulfilment)
  const count = orderCount(lines)
  // Stable for the life of the panel, and obviously not a real ticket number.
  const ticket = 100 + (Math.abs(lines.length * 37 + count * 11) % 800)

  return (
    <div className="placed" role="dialog" aria-modal="true" aria-label="Order placed">
      <div className="placed__card">
        <span className="placed__tick" aria-hidden="true">
          ✓
        </span>
        <h2 className="placed__title">In the oven</h2>
        <p className="placed__eta">
          {f.label} · <strong>{f.eta}</strong> · ticket #{ticket}
        </p>

        <ul className="placed__list">
          {lines.map((l) => (
            <li key={l.id}>
              <span>
                {l.qty > 1 && <b>{l.qty}× </b>}
                {describeLine(l)}
              </span>
              <span>{money(linePrice(l))}</span>
            </li>
          ))}
          {meals > 0 && (
            <li>
              <span>
                {meals > 1 && <b>{meals}x </b>}
                {MEAL.label}
              </span>
              <span>{money(mealTotal(meals))}</span>
            </li>
          )}
        </ul>

        <p className="placed__total">
          <span>Paid on {f.id === 'pickup' ? 'collection' : 'delivery'}</span>
          <strong>{money(grandTotal(lines, fulfilment, meals))}</strong>
        </p>

        <button type="button" className="cta cta--go" onClick={onDone}>
          <span>Start a new order</span>
        </button>
      </div>
    </div>
  )
}
