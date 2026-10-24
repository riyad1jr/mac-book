import type { Product } from '../types'

/* ---------------------------------------------------------------
   Packed units: rolls, boxes, cartons, bags ...

   Stock is always stored in the smallest unit the shop sells
   (pieces, or meters for rolls). A product can also have a pack
   size: "Meters per roll" or "Units per box". These helpers turn a
   stored base quantity back into what the shop actually counts.

   Before this, rolls were converted back for display but every other
   pack unit was not: 10 cartons of 100 showed as a bare "1000" in the
   Items list while the pipe beside it correctly said "89 rolls".
   --------------------------------------------------------------- */

/** Meter-based units (pipe sold by the roll, cut by the meter). */
export const isRollUnit = (unit?: string): boolean =>
  !!unit && /roll|meter|length/.test(unit.toLowerCase()) && !unit.toLowerCase().includes('box')

/** Units that are themselves the smallest sellable unit. */
const BASE_UNITS = /^(pcs|pc|piece|pieces|unit|units|kilo|kg|kilogram|liter|litre|l)\b/i

/** True when the product is counted in packs of more than one base unit. */
export const isPackUnit = (product?: Product): boolean =>
  !!product && (product.packQty || 1) > 1 && !!product.unit && !BASE_UNITS.test(product.unit.trim())

/** "m" for roll products, "pcs" for everything else. */
export const baseUnitSymbol = (product?: Product): string => (isRollUnit(product?.unit) ? 'm' : 'pcs')

/** The base unit as a word, for labels: "meter" or "piece" (or "kg"). */
export const baseUnitWord = (product?: Product): string => {
  if (isRollUnit(product?.unit)) return 'meter'
  if (/kilo|kg/i.test(product?.unit || '')) return 'kg'
  return 'piece'
}

/** "roll (meter)" -> "roll", "carton" -> "carton". */
export const packUnitName = (product?: Product): string =>
  (product?.unit || 'pcs').split(' (')[0].trim() || 'pack'

/** Simple English plural, good enough for shop units. */
export const pluralUnit = (name: string, n: number): string => {
  if (n === 1) return name
  if (/(x|s|ch|sh)$/i.test(name)) return `${name}es`
  return `${name}s`
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/**
 * Describe a stored base quantity in the shop's own units:
 *   1000 pcs, 100 per carton  -> "10 cartons (1,000 pcs)"
 *    950 pcs, 100 per carton  -> "9 cartons + 50 pcs"
 *     40 pcs, 100 per carton  -> "40 pcs"
 * Products without a pack size fall back to "<qty> <unit>".
 */
export const packBreakdown = (base: number, product?: Product): string => {
  const sym = baseUnitSymbol(product)
  if (!isPackUnit(product)) return `${fmt(base)} ${product?.unit ? product.unit.split(' (')[0] : sym}`
  const per = product!.packQty || 1
  const name = packUnitName(product)
  const full = Math.floor(base / per + 1e-9)
  const rest = Math.round((base - full * per) * 100) / 100
  if (full === 0) return `${fmt(rest)} ${sym}`
  const packs = `${fmt(full)} ${pluralUnit(name, full)}`
  if (rest === 0) return `${packs} (${fmt(base)} ${sym})`
  return `${packs} + ${fmt(rest)} ${sym}`
}
