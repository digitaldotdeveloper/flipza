/**
 * What can be ordered, and what it costs.
 *
 * Separate from scene.ts, which is geometry: the scene knows how a pizza
 * tumbles, this knows what a pizza *is*. The flavour list itself still comes
 * from the sprites on disk (scene.ts `FLAVORS`), so a flavour generated with
 * gen-flavor.mjs appears in the menu automatically - only its price and
 * description are written here, and anything missing falls back to the base
 * price and no description.
 */
import { FLAVORS, labelFor } from './scene'
import type { Flavor } from './scene'

export const CURRENCY = '€'

/** Formats a price the way the UI shows it everywhere: €12.50, never €12.5. */
export const money = (v: number) => `${CURRENCY}${v.toFixed(2)}`

interface FlavorInfo {
  price: number
  blurb: string
}

const FLAVOR_INFO: Record<string, FlavorInfo> = {
  margherita: { price: 8.5, blurb: 'Fior di latte, basil, San Marzano' },
  pepperoni: { price: 9.5, blurb: 'Cupped pepperoni, mozzarella' },
  veggie: { price: 9.0, blurb: 'Peppers, olives, mushroom, red onion' },
  diavola: { price: 10.0, blurb: 'Spicy salami, fresh chilli, chilli oil' },
  formaggi: { price: 10.5, blurb: 'Mozzarella, gorgonzola, fontina, parmesan' },
  speciale: { price: 11.5, blurb: 'Ham, mushroom, olives, artichoke, capers' },
}

const FALLBACK: FlavorInfo = { price: 9.5, blurb: '' }

export const flavorInfo = (f: Flavor): FlavorInfo => FLAVOR_INFO[f] ?? FALLBACK

// ----------------------------------------------------------------- sizes ---

export interface Size {
  id: string
  label: string
  inches: string
  /** Multiplier on the drawn pizza. The peel is fixed, so this is visible. */
  scale: number
  /** Added to the flavour's base price. */
  surcharge: number
}

/**
 * Three sizes, and the scale is the point of them: the pizza on the peel
 * actually grows, so picking a size is a thing you watch rather than a radio
 * button you read. The range is deliberately modest - a large has to still fit
 * on the blade, which is only 4% wider than the pizza at rest.
 */
export const SIZES: Size[] = [
  { id: 'S', label: 'Small', inches: '9"', scale: 0.82, surcharge: 0 },
  { id: 'M', label: 'Medium', inches: '12"', scale: 1, surcharge: 2.5 },
  { id: 'L', label: 'Large', inches: '15"', scale: 1.16, surcharge: 5 },
]

export const DEFAULT_SIZE = SIZES[1]

export const sizeById = (id: string) => SIZES.find((s) => s.id === id) ?? DEFAULT_SIZE

// ---------------------------------------------------------------- extras ---

export interface Extra {
  id: string
  label: string
  price: number
  /** Sprite sheet in public/toppings, cut into pieces by prepare-toppings. */
  sprite: string
}

export const EXTRAS: Extra[] = [
  { id: 'cheese', label: 'Extra cheese', price: 1.5, sprite: 'cheese' },
  { id: 'olives', label: 'Black olives', price: 1.2, sprite: 'olives' },
  { id: 'chilli', label: 'Fresh chilli', price: 1.2, sprite: 'chilli' },
  { id: 'basil', label: 'Basil', price: 1.0, sprite: 'basil' },
]

export const extraById = (id: string) => EXTRAS.find((e) => e.id === id)

// ----------------------------------------------------------------- order ---

export interface OrderLine {
  /** Stable id, so React keys survive a line being removed from the middle. */
  id: string
  flavor: Flavor
  size: string
  extras: string[]
  qty: number
}

/** What one of that line costs, before quantity. */
export function unitPrice(line: Pick<OrderLine, 'flavor' | 'size' | 'extras'>) {
  const base = flavorInfo(line.flavor).price + sizeById(line.size).surcharge
  const extras = line.extras.reduce((sum, id) => sum + (extraById(id)?.price ?? 0), 0)
  return base + extras
}

export const linePrice = (line: OrderLine) => unitPrice(line) * line.qty

export const orderTotal = (lines: OrderLine[]) => lines.reduce((sum, l) => sum + linePrice(l), 0)

export const orderCount = (lines: OrderLine[]) => lines.reduce((sum, l) => sum + l.qty, 0)

/** "MARGHERITA · 12" · extra cheese, basil" - one line of plain text. */
export function describeLine(line: OrderLine) {
  const parts = [labelFor(line.flavor), sizeById(line.size).inches]
  if (line.extras.length) {
    parts.push(line.extras.map((id) => extraById(id)?.label.toLowerCase() ?? id).join(', '))
  }
  return parts.join(' · ')
}

// -------------------------------------------------------------- delivery ---

export interface Fulfilment {
  id: string
  label: string
  detail: string
  fee: number
  eta: string
}

export const FULFILMENT: Fulfilment[] = [
  { id: 'delivery', label: 'Delivery', detail: 'To your door', fee: 2.5, eta: '25–35 min' },
  { id: 'pickup', label: 'Pickup', detail: 'From the counter', fee: 0, eta: '12–18 min' },
]

export const fulfilmentById = (id: string) => FULFILMENT.find((f) => f.id === id) ?? FULFILMENT[0]

/** Every flavour that has sprites, in menu order, with its price attached. */
export const MENU = FLAVORS.map((f) => ({
  flavor: f,
  label: labelFor(f),
  ...flavorInfo(f),
}))

/** Order total including the fulfilment fee, which a free pickup waives. */
export function grandTotal(lines: OrderLine[], fulfilment: string) {
  const goods = orderTotal(lines)
  return goods + (lines.length ? fulfilmentById(fulfilment).fee : 0)
}
