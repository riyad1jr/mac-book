/* ---------------------------------------------------------------
   Features that differ between the two shops' builds.

   This tree is the Mame (Mac) build. scripts/make-brand.cjs flips
   these when it generates the Avanza (Windows) build.
   --------------------------------------------------------------- */

/** Purchases can be recorded by the single piece as well as by the carton (Avanza asked for it). */
export const PURCHASE_BY_PIECE = false

/** "Stock list" PDF on the Items page: quantity and stock value per item (Mame asked for it). */
export const ITEMS_STOCK_PDF = true

/**
 * FIFO costing (Mame asked for it): profit uses each purchase batch's own
 * price, oldest stock sells first; purchases no longer overwrite the item's
 * cost; Items shows a per-item batch "Detail" instead of a cost column; the
 * purchase and sales lists show the unit price.
 */
export const FIFO_COSTING = true
