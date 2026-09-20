/**
 * The order itself: what is in it, how it arrives, what it costs.
 *
 * The list is the one thing on the page allowed its own scrollbar. Everything
 * else fits a single screen by design, but an order can be any length, and the
 * alternatives - shrinking the rows until they are unreadable, or hiding lines
 * behind a "+2 more" - are both worse than letting four lines' worth of list
 * scroll inside its own box.
 */
import {
  FULFILMENT,
  describeLine,
  fulfilmentById,
  grandTotal,
  linePrice,
  money,
  orderTotal,
} from '../menu'
import type { Ctl } from './Dock'

export default function OrderList({ ctl }: { ctl: Ctl }) {
  const fee = fulfilmentById(ctl.fulfilment)
  const goods = orderTotal(ctl.lines)

  if (!ctl.lines.length) {
    return (
      <div className="order order--empty">
        <p>Nothing in the order yet.</p>
        <button type="button" className="link" onClick={() => ctl.go('flavour')}>
          Build a pizza
        </button>
      </div>
    )
  }

  return (
    <div className="order">
      <ul className="order__list">
        {ctl.lines.map((line) => (
          <li key={line.id} className="order__line">
            <div className="order__text">
              <span className="order__name">{describeLine(line)}</span>
              <span className="order__price">{money(linePrice(line))}</span>
            </div>
            <div className="qty" role="group" aria-label="Quantity">
              <button
                type="button"
                className="qty__btn"
                aria-label="One fewer"
                onClick={() => ctl.setQty(line.id, line.qty - 1)}
              >
                −
              </button>
              <span className="qty__n">{line.qty}</span>
              <button
                type="button"
                className="qty__btn"
                aria-label="One more"
                onClick={() => ctl.setQty(line.id, line.qty + 1)}
              >
                +
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="order__foot">
        <div className="segmented" role="group" aria-label="How it arrives">
          {FULFILMENT.map((f) => (
            <button
              key={f.id}
              type="button"
              className="segmented__btn"
              data-on={f.id === ctl.fulfilment || undefined}
              onClick={() => ctl.setFulfilment(f.id)}
            >
              <span>{f.label}</span>
              <small>{f.fee ? money(f.fee) : 'free'}</small>
            </button>
          ))}
        </div>

        <dl className="totals">
          <div>
            <dt>Pizzas</dt>
            <dd>{money(goods)}</dd>
          </div>
          <div>
            <dt>{fee.label}</dt>
            <dd>{fee.fee ? money(fee.fee) : 'free'}</dd>
          </div>
          <div className="totals__sum">
            <dt>Total</dt>
            <dd>{money(grandTotal(ctl.lines, ctl.fulfilment))}</dd>
          </div>
        </dl>

        <button type="button" className="link" onClick={() => ctl.go('flavour')}>
          + Add another pizza
        </button>
      </div>
    </div>
  )
}
