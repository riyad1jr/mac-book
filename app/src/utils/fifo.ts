import type { Product, Purchase, Sale } from '../types'

/* ---------------------------------------------------------------
   FIFO costing (first in, first out).

   Every purchase is a batch with its own price. Replaying purchases and
   sales in date order, each sale uses up the oldest stock first and takes
   that batch's price as its cost. Profit therefore depends only on real
   purchases and sales - never on the price field of the item itself.

   Stock that has no purchase behind it (typed in when the item was
   created, or before purchases were recorded) becomes an "Opening stock"
   batch, valued at the item's cost price - the only price there is for it.
   Its quantity is whatever makes the batches add up to the item's stock:
       opening = stock now - everything bought + everything sold
   If that comes out negative (stock was lowered by hand), the difference
   is taken off the oldest remaining batches at the end.

   Nothing here is stored: it is recomputed from the records, so editing
   a purchase or a sale updates every figure that depends on it.
   --------------------------------------------------------------- */

export type Batch = {
  key: string
  kind: 'opening' | 'purchase'
  purchaseId?: string
  date: string
  supplier: string
  unitCost: number
  bought: number
  left: number
}

export type SaleCost = {
  cost: number
  /** Part of the sale had no batch to come from and was costed at the item's cost price. */
  estimated: boolean
}

export type FifoResult = {
  /** Batches per product id, oldest first. */
  batches: Map<string, Batch[]>
  /** Cost of goods for each sale id. */
  saleCost: Map<string, SaleCost>
}

type Event =
  | { kind: 'purchase'; at: string; seq: number; purchase: Purchase; qty: number }
  | { kind: 'sale'; at: string; seq: number; sale: Sale }

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000

export function computeFifo(
  products: Product[],
  purchases: Purchase[],
  sales: Sale[],
  options: {
    purchaseQty: (purchase: Purchase, product?: Product) => number
    saleProduct: (sale: Sale) => Product | undefined
    timeOf: (record: { date: string; time: string; tz?: 'local' }) => string
  },
): FifoResult {
  const byId = new Map(products.map((p) => [p.id, p]))
  const events = new Map<string, Event[]>()
  const push = (productId: string, e: Event) => { const list = events.get(productId) ?? []; list.push(e); events.set(productId, list) }

  purchases.forEach((purchase, index) => {
    const product = byId.get(purchase.productId) ?? products.find((p) => p.name === purchase.productName)
    if (!product) return
    push(product.id, { kind: 'purchase', at: `${purchase.date} ${options.timeOf(purchase)}`, seq: index, purchase, qty: options.purchaseQty(purchase, product) })
  })
  sales.forEach((sale, index) => {
    const product = options.saleProduct(sale)
    if (!product) return
    push(product.id, { kind: 'sale', at: `${sale.date} ${options.timeOf(sale)}`, seq: index, sale })
  })

  const batchesOut = new Map<string, Batch[]>()
  const saleCost = new Map<string, SaleCost>()

  for (const product of products) {
    const list = (events.get(product.id) ?? []).sort((a, b) =>
      a.at.localeCompare(b.at) || (a.kind === b.kind ? a.seq - b.seq : a.kind === 'purchase' ? -1 : 1))
    const bought = list.reduce((sum, e) => sum + (e.kind === 'purchase' ? e.qty : 0), 0)
    const sold = list.reduce((sum, e) => sum + (e.kind === 'sale' ? e.sale.quantity : 0), 0)
    const openingQty = round4((product.stock || 0) - bought + sold)
    const fallbackCost = product.costPrice || 0

    const batches: Batch[] = []
    if (openingQty > 0) {
      const firstDate = list[0]?.at.slice(0, 10) ?? ''
      batches.push({ key: `opening-${product.id}`, kind: 'opening', date: firstDate, supplier: 'Opening stock', unitCost: fallbackCost, bought: openingQty, left: openingQty })
    }
    // Sales that came before any stock was there (dates out of order) wait
    // for the next batch and take its price.
    const waiting: { saleId: string; qty: number }[] = []
    const costSoFar = new Map<string, { cost: number; estimated: boolean }>()
    const addCost = (saleId: string, cost: number, estimated = false) => {
      const c = costSoFar.get(saleId) ?? { cost: 0, estimated: false }
      c.cost += cost
      c.estimated = c.estimated || estimated
      costSoFar.set(saleId, c)
    }
    const take = (saleId: string, qty: number) => {
      let need = qty
      for (const batch of batches) {
        if (need <= 0) break
        if (batch.left <= 0) continue
        const used = Math.min(batch.left, need)
        batch.left = round4(batch.left - used)
        need = round4(need - used)
        addCost(saleId, used * batch.unitCost)
      }
      return need
    }

    for (const e of list) {
      if (e.kind === 'purchase') {
        const qty = e.qty
        const unitCost = qty > 0 && e.purchase.totalCost != null ? e.purchase.totalCost / qty : e.purchase.unitCost || 0
        batches.push({ key: e.purchase.id, kind: 'purchase', purchaseId: e.purchase.id, date: e.purchase.date, supplier: e.purchase.supplier, unitCost, bought: qty, left: qty })
        while (waiting.length) {
          const w = waiting[0]
          const rest = take(w.saleId, w.qty)
          if (rest > 0) { w.qty = rest; break }
          waiting.shift()
        }
      } else {
        costSoFar.set(e.sale.id, costSoFar.get(e.sale.id) ?? { cost: 0, estimated: false })
        const rest = take(e.sale.id, e.sale.quantity)
        if (rest > 0) waiting.push({ saleId: e.sale.id, qty: rest })
      }
    }
    // Never matched by any batch: cost it at the item's price and say so.
    for (const w of waiting) addCost(w.saleId, w.qty * fallbackCost, true)

    // Stock lowered by hand: take the difference off the oldest batches.
    let excess = round4(batches.reduce((sum, b) => sum + b.left, 0) - (product.stock || 0))
    for (const batch of batches) {
      if (excess <= 0) break
      const cut = Math.min(batch.left, excess)
      batch.left = round4(batch.left - cut)
      excess = round4(excess - cut)
    }

    for (const [saleId, c] of costSoFar) saleCost.set(saleId, { cost: round2(c.cost), estimated: c.estimated })
    batchesOut.set(product.id, batches)
  }

  return { batches: batchesOut, saleCost }
}

/** Value of the stock still on hand, batch by batch. */
export const stockValueOf = (batches: Batch[] = []) => round2(batches.reduce((sum, b) => sum + b.left * b.unitCost, 0))
