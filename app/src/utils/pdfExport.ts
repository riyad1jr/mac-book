/**
 * Clean & Professional PDF & Printable Report Generator
 * Builds styled printable documents and PDF downloads directly in browser
 */

import type { Expense, Product, Purchase, Sale } from '../types'

/** One supplier's balance, as the Suppliers page computes it. */
export type SupplierDebt = { name: string; phone?: string; owed: number; nextDue?: string; openPurchases: number }
import { packBreakdown, baseUnitSymbol } from './units'
import { toEthiopianDate, formatDualDate } from './ethiopianCalendar'
import { inPeriod as inCalendarPeriod } from './periods'


/* ---------------------------------------------------------------
   Delivering a printable document.

   In the desktop app the HTML is handed to the shell, which renders it
   to a real PDF with Chromium's built-in engine and shows a Save dialog.
   No printer is involved. The old approach - open a window and call
   window.print() - depended on Windows having a "Print to PDF" printer
   installed, and on machines without one it simply did nothing.

   In a plain browser (development) the old print flow is used.
   --------------------------------------------------------------- */
async function deliverPrintable(html: string, suggestedName: string): Promise<void> {
  const desktop = (window as any).desktop
  if (desktop?.savePdf) {
    // The document embeds a window.print() call for the browser path;
    // it must not run inside the PDF renderer.
    const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '')
    try {
      const result = await desktop.savePdf(clean, suggestedName)
      if (result?.ok) {
        window.dispatchEvent(new CustomEvent('mame:toast', { detail: `PDF saved: ${result.path}` }))
      } else if (!result?.cancelled) {
        window.alert(`Could not save the PDF: ${result?.message ?? 'unknown error'}`)
      }
    } catch (err) {
      window.alert(`Could not save the PDF: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
    return
  }
  const printWindow = window.open('', '_blank')
  if (printWindow) {
    printWindow.document.write(html)
    printWindow.document.close()
  } else {
    window.alert('The report window was blocked. Please allow pop-ups for this app.')
  }
}


/**
 * Escape a value before putting it into the printable HTML.
 *
 * Product, customer and supplier names are typed by shop staff. A name like
 * `1/2" <pipe>` or `Tadesse & Sons` used to be pasted raw into the report
 * markup, which corrupted the layout and allowed arbitrary HTML into the
 * document. Everything user-entered now goes through here.
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Row cap for printable tables.
 *
 * A shop with two years of history has thousands of transactions. Printing
 * them all produced a 238-page, 14-second PDF that nobody would use. The
 * detail tables show the most recent rows and say so plainly; the totals and
 * summaries above them still cover the entire period, so no figure is ever
 * understated.
 */
const MAX_TABLE_ROWS = 300

function capRows<T>(rows: T[]): { shown: T[]; hidden: number } {
  if (rows.length <= MAX_TABLE_ROWS) return { shown: rows, hidden: 0 }
  return { shown: rows.slice(0, MAX_TABLE_ROWS), hidden: rows.length - MAX_TABLE_ROWS }
}

function cappedNotice(hidden: number, total: number, colSpan: number): string {
  if (!hidden) return ''
  return `<tr><td colspan="${colSpan}" style="padding:10px; text-align:center; color:#64748b; font-style:italic; background:#f8fafc;">
    Showing the ${MAX_TABLE_ROWS} most recent of ${total.toLocaleString()} transactions. The totals above cover the full period.
  </td></tr>`
}
function safeFilename(s: string): string {
  return s.replace(/[^\w\u1200-\u137F.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}


const EXPENSE_CATEGORY_AM: Record<string, string> = {
  'Rent': 'ኪራይ',
  'Transport (Isuzu)': 'ትራንስፖርት (ኢሱዙ)',
  'Light bill': 'የኤሌክትሪክ ክፍያ',
  'Daily labor': 'የዕለት ሠራተኛ',
  'Other': 'ሌላ',
}
const expenseCategoryLabel = (value: string) => { const am = EXPENSE_CATEGORY_AM[value]; return am ? `${value} (${am})` : value }

/** Local calendar date "YYYY-MM-DD" (toISOString is UTC: 3 hours behind in Ethiopia). */
const localISO = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const fmt = (value: number, decimals = 2) => value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
const fmtQty = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

const isRollUnit = (unit?: string) => !!unit && !!/roll|meter|length/.test(unit.toLowerCase()) && !unit.toLowerCase().includes('box')
// Same wording as the app itself: "10 cartons (1,000 pcs)".
const salesQtyLabel = (qty: number, product?: Product) => packBreakdown(qty, product)

export function generatePDFReport(options: {
  title: string
  period: string
  branch: string
  sales: Sale[]
  purchases: Purchase[]
  products: Product[]
  /** Current balances owed to suppliers (all time, not just this period). */
  supplierDebts?: SupplierDebt[]
  /** Cost of goods for a sale (FIFO). Falls back to quantity x item cost. */
  costOfSale?: (sale: Sale) => number
}) {
  const { title, period, branch, sales, purchases, products } = options
  const debts = (options.supplierDebts ?? []).filter((d) => d.owed > 0)
  const totalOwedToSuppliers = debts.reduce((sum, d) => sum + d.owed, 0)
  const today = localISO()
  const debtRows = debts.map((d) => `
    <tr>
      <td><b>${esc(d.name)}</b></td>
      <td>${esc(d.phone || '-')}</td>
      <td>${d.openPurchases}</td>
      <td style="color:#dc2626; font-weight:600;">ETB ${fmt(d.owed)}</td>
      <td>${d.nextDue ? (d.nextDue < today ? `<span style="color:#dc2626; font-weight:600;">Overdue since ${esc(d.nextDue)}</span>` : esc(d.nextDue)) : '-'}</td>
    </tr>`).join('')

  const todayGc = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  const ethToday = toEthiopianDate(new Date())

  const totalSalesRevenue = sales.reduce((sum, s) => sum + (s.total || 0), 0)
  const totalPaid = sales.reduce((sum, s) => sum + (s.paid || 0), 0)
  const totalCreditOwed = sales.reduce((sum, s) => sum + Math.max((s.total || 0) - (s.paid || 0), 0), 0)
  const totalSalesQty = sales.reduce((sum, s) => sum + (s.quantity || 0), 0)
  const totalSalesQtyInRolls = sales.reduce((sum, s) => {
    const product = (products.find((item) => item.id === (s as { productId?: string }).productId) ?? products.find((item) => item.name === s.productName))
    if (product?.packQty) return sum + Math.round((s.quantity / product.packQty) * 100) / 100
    return sum + (s.quantity || 0)
  }, 0)
  const purchaseCost = (p: Purchase) => (p.totalCost ?? (p.quantity || 0) * (p.unitCost || 0))
  const totalPurchaseSpend = purchases.reduce((sum, p) => sum + purchaseCost(p), 0)
  // Purchases from before supplier credit existed have no `paid`: fully paid.
  const purchasePaidOf = (p: Purchase) => Math.min(p.paid ?? purchaseCost(p), purchaseCost(p))
  const totalPurchasePaid = purchases.reduce((sum, p) => sum + purchasePaidOf(p), 0)
  const totalCostOfGoodsSold = sales.reduce((sum, s) => {
    const product = (products.find((item) => item.id === (s as { productId?: string }).productId) ?? products.find((item) => item.name === s.productName))
    return sum + (options.costOfSale ? options.costOfSale(s) : (s.quantity || 0) * (product?.costPrice ?? 0))
  }, 0)
  const grossProfit = totalSalesRevenue - totalCostOfGoodsSold
  const grossMargin = totalSalesRevenue > 0 ? (grossProfit / totalSalesRevenue) * 100 : 0

  const salesCap = capRows([...sales].reverse())
  const salesTableRows = salesCap.shown.map((s) => {
    const product = (products.find((item) => item.id === (s as { productId?: string }).productId) ?? products.find((item) => item.name === s.productName))
    const unitPrice = s.unitPrice ?? (s.quantity ? s.total / s.quantity : 0)
    return `
    <tr>
      <td><b>${esc(s.productName)}</b></td>
      <td>${esc(s.customer)}</td>
      <td>${esc(salesQtyLabel(s.quantity, product))}</td>
      <td>ETB ${fmt(unitPrice)}</td>
      <td>ETB ${fmt(s.total)}</td>
      <td>ETB ${fmt(s.paid)}</td>
      <td>${s.paid >= s.total ? '<span style="color: green;">Paid</span>' : `<span style="color: red;">ETB ${fmt(s.total - s.paid)}</span>`}</td>
      <td>${esc(s.date)}</td>
    </tr>
  `
  }).join('')

  const purchasesCap = capRows([...purchases].reverse())
  const purchasesTableRows = purchasesCap.shown.map((p) => {
    const product = (products.find((item) => item.id === p.productId) ?? products.find((item) => item.name === p.productName))
    const sku = product?.sku
    return `
    <tr>
      <td><b>${esc(p.productName)}</b>${sku ? `<small style="color:#64748b; margin-left:5px;">(${esc(sku)})</small>` : ''}</td>
      <td>${esc(p.supplier)}</td>
      <td>${esc(packBreakdown(p.buyBy === 'base' ? p.quantity : p.quantity * (product?.packQty || 1), product))}</td>
      <td>ETB ${fmt(p.unitCost || 0)} / ${baseUnitSymbol(product)}</td>
      <td>ETB ${fmt(purchaseCost(p))}</td>
      <td>ETB ${fmt(purchasePaidOf(p))}</td>
      <td>${purchaseCost(p) - purchasePaidOf(p) > 0.004 ? `<span style="color:#dc2626; font-weight:600;">ETB ${fmt(purchaseCost(p) - purchasePaidOf(p))}</span>` : '<span style="color:#16a34a;">Paid</span>'}</td>
      <td>${esc(p.date)}</td>
    </tr>
  `
  }).join('')

  const printHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${esc(title)} - ${esc(branch)}</title>
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; padding: 30px; margin: 0; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #c2410c; padding-bottom: 15px; margin-bottom: 20px; }
          .brand { font-size: 24px; font-weight: 800; color: #c2410c; letter-spacing: -0.5px; }
          .subtitle { font-size: 13px; color: #64748b; margin-top: 4px; }
          .meta-box { text-align: right; font-size: 12px; color: #475569; }
          .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 25px; }
          .metric-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #f8fafc; }
          .metric-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; }
          .metric-val { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 4px; }
          h3 { font-size: 15px; margin-top: 25px; margin-bottom: 10px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
          th { text-align: left; background: #f1f5f9; padding: 8px 10px; border-bottom: 1px solid #cbd5e1; color: #475569; font-size: 10px; text-transform: uppercase; }
          td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
          .ledger-grid { margin-top: 20px; }
          .ledger { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #fff; margin-bottom: 16px; }
          .ledger h3 { margin-top: 0; }
          .ledger table { font-size: 11px; }
          .ledger th, .ledger td { padding: 6px 8px; }
          .total-row td { font-weight: 700; background: #f8fafc; border-top: 2px solid #cbd5e1; color: #0f172a; }
          .summary-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 25px; }
          .summary-box { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #fff; text-align: center; }
          .summary-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; }
          .summary-val { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 4px; }
          .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
          @media print {
            body { padding: 0; }
            thead { display: table-header-group; }
            tr { break-inside: avoid; }
            .ledger { break-inside: auto; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="brand">MAME INVENTORY & SALES</div>
            <div class="subtitle">${esc(title)} &bull; ${esc(branch)}</div>
          </div>
          <div class="meta-box">
            <div><b>Gregorian:</b> ${todayGc}</div>
            <div><b>Ethiopian:</b> ${ethToday.monthNameAm} ${ethToday.day}, ${ethToday.year} E.C.</div>
            <div><b>Period:</b> ${esc(period)}</div>
          </div>
        </div>

        <div class="summary-strip">
          <div class="summary-box">
            <div class="summary-label">Sales Revenue (የሽያጭ ገቢ)</div>
            <div class="summary-val">ETB ${fmt(totalSalesRevenue)}</div>
          </div>
          <div class="summary-box">
            <div class="summary-label">Cost of Goods Sold (የሸቀጥ ዋጋ)</div>
            <div class="summary-val">ETB ${fmt(totalCostOfGoodsSold)}</div>
          </div>
          <div class="summary-box">
            <div class="summary-label">Gross Profit (ጠቅላላ ትርፍ)</div>
            <div class="summary-val" style="color: ${grossProfit >= 0 ? '#16a34a' : '#dc2626'};">ETB ${fmt(grossProfit)}</div>
          </div>
          <div class="summary-box">
            <div class="summary-label">Margin</div>
            <div class="summary-val">${grossMargin.toLocaleString('en-US', { maximumFractionDigits: 1 })}%</div>
          </div>
        </div>

        <div class="metrics">
          <div class="metric-card">
            <div class="metric-label">Cash Collected (የተሰበሰበ ገንዘብ)</div>
            <div class="metric-val">ETB ${fmt(totalPaid)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Credit Outstanding (ያልተከፈለ ዕዳ)</div>
            <div class="metric-val" style="color:#dc2626;">ETB ${fmt(totalCreditOwed)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Purchase Spend (የግዢ ወጪ)</div>
            <div class="metric-val">ETB ${fmt(totalPurchaseSpend)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Owed to Suppliers (ለአቅራቢ ያለ ዕዳ)</div>
            <div class="metric-val" style="color:${totalOwedToSuppliers > 0 ? '#dc2626' : '#0f172a'};">ETB ${fmt(totalOwedToSuppliers)}</div>
          </div>
        </div>

        <div class="ledger-grid">
          <div class="ledger">
            <h3>Sales & Payments (${sales.length} Transactions)</h3>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Customer</th>
                  <th>Qty</th>
                  <th>Unit Price</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Balance</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                ${salesTableRows || '<tr><td colspan="8" style="text-align:center;">No sales recorded for this period.</td></tr>'}${cappedNotice(salesCap.hidden, sales.length, 8)}
                <tr class="total-row">
                  <td colspan="2" style="text-align:right;">Total (${sales.length})</td>
                   <td>${fmtQty(totalSalesQtyInRolls)}</td>
                  <td></td>
                  <td>ETB ${fmt(totalSalesRevenue)}</td>
                  <td>ETB ${fmt(totalPaid)}</td>
                  <td>ETB ${fmt(totalCreditOwed)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="ledger">
            <h3>Purchase Spend (${purchases.length} Transactions)</h3>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Supplier</th>
                  <th>Qty</th>
                  <th>Unit Cost</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Owed</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                ${purchasesTableRows || '<tr><td colspan="8" style="text-align:center;">No purchases recorded for this period.</td></tr>'}${cappedNotice(purchasesCap.hidden, purchases.length, 8)}
                <tr class="total-row">
                  <td colspan="2" style="text-align:right;">Total (${purchases.length})</td>
                  <td></td>
                  <td></td>
                  <td>ETB ${fmt(totalPurchaseSpend)}</td>
                  <td>ETB ${fmt(totalPurchasePaid)}</td>
                  <td>ETB ${fmt(totalPurchaseSpend - totalPurchasePaid)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="ledger">
            <h3>Owed to Suppliers (ለአቅራቢ ያለ ዕዳ) &mdash; as of ${todayGc}</h3>
            <table>
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Phone</th>
                  <th>Unpaid purchases</th>
                  <th>Owed</th>
                  <th>Next due</th>
                </tr>
              </thead>
              <tbody>
                ${debtRows || '<tr><td colspan="5" style="text-align:center;">Nothing is owed to any supplier.</td></tr>'}
                ${debts.length ? `<tr class="total-row"><td colspan="3" style="text-align:right;">Total owed</td><td>ETB ${fmt(totalOwedToSuppliers)}</td><td></td></tr>` : ''}
              </tbody>
            </table>
          </div>
        </div>

        <div class="footer">
          Generated automatically by Mame Inventory Operations &bull; ${new Date().toISOString()}
        </div>

        <script>
          window.onload = function() {
            window.print();
          }
        </script>
      </body>
    </html>
  `

  void deliverPrintable(printHtml, `mame-report-${safeFilename(String(options.period))}.pdf`)
}

export function generateCustomerPDF(options: {
  customer: { name: string; phone?: string; email?: string; createdAt?: string }
  sales: Sale[]
  products: Product[]
}) {
  const { customer, sales, products } = options

  const todayGc = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  const ethToday = toEthiopianDate(new Date())

  const totalSpent = sales.reduce((sum, s) => sum + (s.total || 0), 0)
  const totalPaid = sales.reduce((sum, s) => sum + (s.paid || 0), 0)
  const totalCredit = sales.reduce((sum, s) => sum + Math.max((s.total || 0) - (s.paid || 0), 0), 0)
  const totalQty = sales.reduce((sum, s) => sum + (s.quantity || 0), 0)
  const totalQtyInRolls = sales.reduce((sum, s) => {
    const product = (products.find((item) => item.id === (s as { productId?: string }).productId) ?? products.find((item) => item.name === s.productName))
    if (product?.packQty) return sum + Math.round((s.quantity / product.packQty) * 100) / 100
    return sum + (s.quantity || 0)
  }, 0)

  const sortedSales = [...sales].sort((a, b) => b.date.localeCompare(a.date))

  const statementCap = capRows(sortedSales)
  const salesRows = statementCap.shown.map((s) => {
    const product = (products.find((item) => item.id === (s as { productId?: string }).productId) ?? products.find((item) => item.name === s.productName))
    const unitPrice = s.unitPrice ?? (s.quantity ? s.total / s.quantity : 0)
    return `
    <tr>
      <td><b>${esc(s.productName)}</b></td>
      <td>${esc(salesQtyLabel(s.quantity, product))}</td>
      <td>ETB ${fmt(unitPrice)}</td>
      <td>ETB ${fmt(s.total)}</td>
      <td>ETB ${fmt(s.paid)}</td>
      <td>${s.paid >= s.total ? '<span style="color: #16a34a; font-weight:600;">Paid</span>' : `<span style="color: #dc2626; font-weight:600;">ETB ${fmt(s.total - s.paid)}</span>`}</td>
      <td>${s.dueDate || '-'}</td>
      <td>${esc(s.date)}</td>
    </tr>
  `
  }).join('')

  const initials = customer.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  const printHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${esc(customer.name)} - Customer Report</title>
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; padding: 30px; margin: 0; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #c2410c; padding-bottom: 15px; margin-bottom: 20px; }
          .brand { font-size: 24px; font-weight: 800; color: #c2410c; letter-spacing: -0.5px; }
          .subtitle { font-size: 13px; color: #64748b; margin-top: 4px; }
          .meta-box { text-align: right; font-size: 12px; color: #475569; }
          .profile-section { display: flex; gap: 20px; align-items: center; margin-bottom: 24px; padding: 18px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
          .avatar { width: 56px; height: 56px; border-radius: 50%; background: #c2410c; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; flex-shrink: 0; }
          .profile-info h2 { margin: 0 0 4px; font-size: 18px; color: #0f172a; }
          .profile-info p { margin: 0; font-size: 12px; color: #64748b; }
          .profile-info p b { color: #475569; }
          .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 25px; }
          .metric-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #fff; }
          .metric-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; }
          .metric-val { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 4px; }
          h3 { font-size: 15px; margin-top: 25px; margin-bottom: 10px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
          th { text-align: left; background: #f1f5f9; padding: 8px 10px; border-bottom: 1px solid #cbd5e1; color: #475569; font-size: 10px; text-transform: uppercase; }
          td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
          .total-row td { font-weight: 700; background: #f8fafc; border-top: 2px solid #cbd5e1; color: #0f172a; }
          .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
          @media print { body { padding: 0; } thead { display: table-header-group; } tr { break-inside: avoid; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="brand">MAME INVENTORY & SALES</div>
            <div class="subtitle">Customer Report &bull; ${esc(customer.name)}</div>
          </div>
          <div class="meta-box">
            <div><b>Gregorian:</b> ${todayGc}</div>
            <div><b>Ethiopian:</b> ${ethToday.monthNameAm} ${ethToday.day}, ${ethToday.year} E.C.</div>
            <div><b>Transactions:</b> ${sales.length}</div>
          </div>
        </div>

        <div class="profile-section">
          <div class="avatar">${esc(initials)}</div>
          <div class="profile-info">
            <h2>${esc(customer.name)}</h2>
            <p><b>Phone:</b> ${esc(customer.phone || 'Not provided')} &nbsp;&nbsp;|&nbsp;&nbsp; <b>Email:</b> ${esc(customer.email || 'Not provided')} &nbsp;&nbsp;|&nbsp;&nbsp; <b>Customer since:</b> ${esc(customer.createdAt || 'Unknown')}</p>
          </div>
        </div>

        <div class="metrics">
          <div class="metric-card">
            <div class="metric-label">Total Spent</div>
            <div class="metric-val">ETB ${fmt(totalSpent)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Paid</div>
            <div class="metric-val" style="color:#16a34a;">ETB ${fmt(totalPaid)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Credit Outstanding</div>
            <div class="metric-val" style="color:#dc2626;">ETB ${fmt(totalCredit)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Items Purchased</div>
            <div class="metric-val">${fmtQty(totalQtyInRolls)}</div>
          </div>
        </div>

        <h3>Sales & Payment History (${sales.length} Transactions)</h3>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty</th>
              <th>Unit Price</th>
              <th>Total</th>
              <th>Paid</th>
              <th>Balance</th>
              <th>Due Date</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            ${salesRows || '<tr><td colspan="8" style="text-align:center; color:#94a3b8;">No sales recorded for this customer.</td></tr>'}${cappedNotice(statementCap.hidden, sortedSales.length, 8)}
            <tr class="total-row">
              <td style="text-align:right;">Total (${sales.length})</td>
              <td></td>
              <td></td>
              <td>ETB ${fmt(totalSpent)}</td>
              <td>ETB ${fmt(totalPaid)}</td>
              <td>ETB ${fmt(totalCredit)}</td>
              <td></td>
              <td></td>
            </tr>
          </tbody>
        </table>

        <div class="footer">
          Generated automatically by Mame Inventory Operations &bull; ${new Date().toISOString()}
        </div>

        <script>
          window.onload = function() {
            window.print();
          }
        </script>
      </body>
    </html>
  `

  void deliverPrintable(printHtml, `mame-customer-${safeFilename(options.customer.name)}.pdf`)
}

export function generateExpensesPDF(options: {
  title?: string
  period: string
  periodKey: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'
  branch: string
  expenses: Expense[]
}) {
  const { title, period, periodKey, branch, expenses } = options

  const todayGc = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  const ethToday = toEthiopianDate(new Date())

  const now = new Date()
  const todayISO = localISO(now)
  const weekStartISO = localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()))
  const monthISO = todayISO.slice(0, 7)
  const yearISO = todayISO.slice(0, 4)

  const inPeriod = (e: Expense) => {
    if (!e.date) return false
    // Same periods as the screens: Monday weeks, Ethiopian month/year.
    const key = periodKey === 'daily' ? 'day' : periodKey === 'weekly' ? 'week' : periodKey === 'monthly' ? 'month' : periodKey === 'yearly' ? 'year' : 'all'
    return inCalendarPeriod(e.date, key, now)
  }
  const scoped = expenses.filter(inPeriod)
  const total = scoped.reduce((sum, e) => sum + e.amount, 0)

  const sorted = [...scoped].sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`))
  const groups = [...new Set(sorted.map((e) => e.category))].map((category) => {
    const items = sorted.filter((e) => e.category === category)
    const subtotal = items.reduce((sum, e) => sum + e.amount, 0)
    return { category, items, subtotal }
  })
  const topCategory = groups.length ? groups.reduce((a, b) => (b.subtotal > a.subtotal ? b : a), groups[0]).category : null

  const rowsHtml = groups.map((g) => `
    <tr class="group-head">
      <td colspan="3">${esc(expenseCategoryLabel(g.category))}</td>
      <td style="text-align:right;">${g.items.length} ${g.items.length === 1 ? 'entry' : 'entries'}</td>
    </tr>
    ${g.items.map((e) => `
      <tr>
        <td>${e.note || '—'}</td>
        <td>${formatDualDate(e.date)}</td>
        <td>${esc(e.category)}</td>
        <td style="text-align:right; color:#dc2626; font-variant-numeric:tabular-nums;">ETB ${fmt(e.amount)}</td>
      </tr>
    `).join('')}
    <tr class="subtotal-row">
      <td colspan="3" style="text-align:right;">${esc(expenseCategoryLabel(g.category))} subtotal</td>
      <td style="text-align:right; color:#dc2626; font-weight:700;">-ETB ${fmt(g.subtotal)}</td>
    </tr>
  `).join('')

  const printHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${title ?? 'Expenses'} - ${esc(branch)}</title>
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; padding: 30px; margin: 0; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #c2410c; padding-bottom: 15px; margin-bottom: 20px; }
          .brand { font-size: 24px; font-weight: 800; color: #c2410c; letter-spacing: -0.5px; }
          .subtitle { font-size: 13px; color: #64748b; margin-top: 4px; }
          .meta-box { text-align: right; font-size: 12px; color: #475569; }
          .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 25px; }
          .metric-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #f8fafc; }
          .metric-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; }
          .metric-val { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 4px; }
          h3 { font-size: 15px; margin-top: 25px; margin-bottom: 10px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 15px; }
          th { text-align: left; background: #f1f5f9; padding: 8px 10px; border-bottom: 1px solid #cbd5e1; color: #475569; font-size: 10px; text-transform: uppercase; }
          td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
          .group-head td { background: #f1f5f9; font-weight: 700; color: #0f172a; text-transform: uppercase; letter-spacing: .3px; border-top: 2px solid #cbd5e1; }
          .subtotal-row td { font-weight: 700; background: #f8fafc; border-top: 1px solid #cbd5e1; }
          .grand-total td { font-weight: 800; background: #0f172a; color: #fff; border-top: 2px solid #c2410c; }
          .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
          @media print { body { padding: 0; } thead { display: table-header-group; } tr { break-inside: avoid; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="brand">MAME INVENTORY & SALES</div>
            <div class="subtitle">${title ?? 'Expenses Report'} &bull; ${esc(branch)}</div>
          </div>
          <div class="meta-box">
            <div><b>Gregorian:</b> ${todayGc}</div>
            <div><b>Ethiopian:</b> ${ethToday.monthNameAm} ${ethToday.day}, ${ethToday.year} E.C.</div>
            <div><b>Period:</b> ${esc(period)}</div>
          </div>
        </div>

        <div class="metrics">
          <div class="metric-card">
            <div class="metric-label">Total Expenses</div>
            <div class="metric-val" style="color:#dc2626;">-ETB ${fmt(total)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Entries</div>
            <div class="metric-val">${scoped.length}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Categories</div>
            <div class="metric-val">${groups.length}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Top Spending</div>
            <div class="metric-val" style="font-size:14px;">${topCategory ? expenseCategoryLabel(topCategory) : '—'}</div>
          </div>
        </div>

        <h3>Expense Ledger (${scoped.length} Transactions) by Category</h3>
        <table>
          <thead>
            <tr>
              <th>Note</th>
              <th>Date</th>
              <th>Category</th>
              <th style="text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${scoped.length === 0 ? '<tr><td colspan="4" style="text-align:center; color:#94a3b8;">No expenses recorded for this period.</td></tr>' : rowsHtml}
            <tr class="grand-total">
              <td colspan="3" style="text-align:right;">Grand Total (${scoped.length})</td>
              <td style="text-align:right;">-ETB ${fmt(total)}</td>
            </tr>
          </tbody>
        </table>

        <div class="footer">
          Generated automatically by Mame Inventory Operations &bull; ${new Date().toISOString()}
        </div>

        <script>
          window.onload = function() {
            window.print();
          }
        </script>
      </body>
    </html>
  `

  void deliverPrintable(printHtml, `mame-expenses-${safeFilename(String(options.period))}.pdf`)
}

/**
 * Supplier statement: every purchase from one supplier, what was paid and
 * what the shop still owes, with due dates. The counterpart of the customer
 * report, for settling up with a supplier.
 */
export function generateSupplierPDF(options: {
  supplier: { name: string; contact?: string; phone?: string; email?: string }
  purchases: Purchase[]
  products: Product[]
}) {
  const { supplier, purchases, products } = options
  const todayGc = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  const ethToday = toEthiopianDate(new Date())
  const today = localISO()

  const cost = (p: Purchase) => p.totalCost ?? (p.quantity || 0) * (p.unitCost || 0)
  // Purchases from before supplier credit existed have no `paid`: fully paid.
  const paidOf = (p: Purchase) => Math.min(p.paid ?? cost(p), cost(p))
  const owedOf = (p: Purchase) => Math.max(Math.round((cost(p) - paidOf(p)) * 100) / 100, 0)

  const totalBought = purchases.reduce((sum, p) => sum + cost(p), 0)
  const totalPaid = purchases.reduce((sum, p) => sum + paidOf(p), 0)
  const totalOwed = purchases.reduce((sum, p) => sum + owedOf(p), 0)
  const overdue = purchases.filter((p) => owedOf(p) > 0 && p.dueDate && p.dueDate < today)
  const totalOverdue = overdue.reduce((sum, p) => sum + owedOf(p), 0)

  const sorted = [...purchases].sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`))
  const cap = capRows(sorted)
  const rows = cap.shown.map((p) => {
    const product = products.find((item) => item.id === p.productId) ?? products.find((item) => item.name === p.productName)
    const owed = owedOf(p)
    const due = owed > 0 && p.dueDate
      ? (p.dueDate < today ? `<span style="color:#dc2626; font-weight:600;">${esc(p.dueDate)} (overdue)</span>` : esc(p.dueDate))
      : '-'
    return `
    <tr>
      <td>${esc(p.date)}</td>
      <td>${esc(p.reference || p.id)}</td>
      <td><b>${esc(p.productName)}</b></td>
      <td>${esc(packBreakdown(p.buyBy === 'base' ? (p.quantity || 0) : (p.quantity || 0) * (product?.packQty || 1), product))}</td>
      <td>ETB ${fmt(p.unitCost || 0)} / ${baseUnitSymbol(product)}</td>
      <td>ETB ${fmt(cost(p))}</td>
      <td>ETB ${fmt(paidOf(p))}</td>
      <td>${owed > 0 ? `<span style="color:#dc2626; font-weight:600;">ETB ${fmt(owed)}</span>` : '<span style="color:#16a34a; font-weight:600;">Paid</span>'}</td>
      <td>${due}</td>
    </tr>`
  }).join('')

  const initials = supplier.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  const printHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${esc(supplier.name)} - Supplier Statement</title>
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; padding: 30px; margin: 0; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #c2410c; padding-bottom: 15px; margin-bottom: 20px; }
          .brand { font-size: 24px; font-weight: 800; color: #c2410c; letter-spacing: -0.5px; }
          .subtitle { font-size: 13px; color: #64748b; margin-top: 4px; }
          .meta-box { text-align: right; font-size: 12px; color: #475569; }
          .profile-section { display: flex; gap: 20px; align-items: center; margin-bottom: 24px; padding: 18px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
          .avatar { width: 56px; height: 56px; border-radius: 50%; background: #c2410c; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; flex-shrink: 0; }
          .profile-info h2 { margin: 0 0 4px; font-size: 18px; color: #0f172a; }
          .profile-info p { margin: 0; font-size: 12px; color: #64748b; }
          .profile-info p b { color: #475569; }
          .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 25px; }
          .metric-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; background: #fff; }
          .metric-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; }
          .metric-val { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 4px; }
          h3 { font-size: 15px; margin-top: 25px; margin-bottom: 10px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
          table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }
          th { text-align: left; background: #f1f5f9; padding: 7px 8px; border-bottom: 1px solid #cbd5e1; color: #475569; font-size: 9px; text-transform: uppercase; }
          td { padding: 7px 8px; border-bottom: 1px solid #e2e8f0; }
          td:nth-child(1), td:nth-child(2), td:nth-child(6), td:nth-child(7), td:nth-child(8), .total-row td { white-space: nowrap; }
          .total-row td { font-weight: 700; background: #f8fafc; border-top: 2px solid #cbd5e1; color: #0f172a; }
          .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
          @media print { body { padding: 0; } thead { display: table-header-group; } tr { break-inside: avoid; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="brand">MAME INVENTORY & SALES</div>
            <div class="subtitle">Supplier Statement (የአቅራቢ ሂሳብ) &bull; ${esc(supplier.name)}</div>
          </div>
          <div class="meta-box">
            <div><b>Gregorian:</b> ${todayGc}</div>
            <div><b>Ethiopian:</b> ${ethToday.monthNameAm} ${ethToday.day}, ${ethToday.year} E.C.</div>
            <div><b>Purchases:</b> ${purchases.length}</div>
          </div>
        </div>

        <div class="profile-section">
          <div class="avatar">${esc(initials)}</div>
          <div class="profile-info">
            <h2>${esc(supplier.name)}</h2>
            <p><b>Contact:</b> ${esc(supplier.contact || 'Not provided')} &nbsp;&nbsp;|&nbsp;&nbsp; <b>Phone:</b> ${esc(supplier.phone || 'Not provided')}${supplier.email ? ` &nbsp;&nbsp;|&nbsp;&nbsp; <b>Email:</b> ${esc(supplier.email)}` : ''}</p>
          </div>
        </div>

        <div class="metrics">
          <div class="metric-card">
            <div class="metric-label">Total Bought</div>
            <div class="metric-val">ETB ${fmt(totalBought)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Total Paid</div>
            <div class="metric-val" style="color:#16a34a;">ETB ${fmt(totalPaid)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Still Owed (ቀሪ ዕዳ)</div>
            <div class="metric-val" style="color:${totalOwed > 0 ? '#dc2626' : '#0f172a'};">ETB ${fmt(totalOwed)}</div>
          </div>
          <div class="metric-card">
            <div class="metric-label">Overdue</div>
            <div class="metric-val" style="color:${totalOverdue > 0 ? '#dc2626' : '#0f172a'};">ETB ${fmt(totalOverdue)}</div>
          </div>
        </div>

        <h3>Purchases & Payments (${purchases.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Ref</th>
              <th>Product</th>
              <th>Qty</th>
              <th>Unit Cost</th>
              <th>Total</th>
              <th>Paid</th>
              <th>Owed</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="9" style="text-align:center; color:#94a3b8;">No purchases recorded from this supplier.</td></tr>'}${cappedNotice(cap.hidden, sorted.length, 9)}
            <tr class="total-row">
              <td colspan="5" style="text-align:right;">Total (${purchases.length})</td>
              <td>ETB ${fmt(totalBought)}</td>
              <td>ETB ${fmt(totalPaid)}</td>
              <td>ETB ${fmt(totalOwed)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>

        <div class="footer">
          Generated automatically by Mame Inventory Operations &bull; ${new Date().toISOString()}
        </div>

        <script>
          window.onload = function() {
            window.print();
          }
        </script>
      </body>
    </html>
  `

  void deliverPrintable(printHtml, `mame-supplier-${safeFilename(supplier.name)}.pdf`)
}

/**
 * Stock list: every item with its quantity and stock value (quantity x cost
 * per piece), and the total. Replaces the "Stock value" card that was taken
 * off the Overview. Values come only from the stock and cost prices entered.
 */
export function generateStockPDF(options: { products: Product[]; batchesOf?: (product: Product) => { left: number; unitCost: number }[] }) {
  const products = [...options.products].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  const todayGc = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  const ethToday = toEthiopianDate(new Date())
  // FIFO: value of the batches still in stock, each at its own purchase price.
  const left = (p: Product) => (options.batchesOf ? options.batchesOf(p).filter((b) => b.left > 0) : [])
  const value = (p: Product) => Math.round((options.batchesOf ? left(p).reduce((s, b) => s + b.left * b.unitCost, 0) : (p.stock || 0) * (p.costPrice || 0)) * 100) / 100
  const costCell = (p: Product) => {
    if (!options.batchesOf) return `ETB ${fmt(p.costPrice || 0)} / ${baseUnitSymbol(p)}`
    const parts = left(p)
    if (!parts.length) return '-'
    return parts.map((b) => `${fmtQty(b.left)} @ ETB ${fmt(b.unitCost)}`).join('<br>')
  }
  const total = Math.round(products.reduce((sum, p) => sum + value(p), 0) * 100) / 100
  const noCost = products.filter((p) => (p.stock || 0) > 0 && !(p.costPrice > 0))
  const rows = products.map((p) => `
    <tr${(p.stock || 0) > 0 && !(p.costPrice > 0) ? ' class="no-cost"' : ''}>
      <td><b>${esc(p.name)}</b>${p.sku ? `<small> (${esc(p.sku)})</small>` : ''}</td>
      <td>${esc(p.category)}</td>
      <td>${esc(packBreakdown(p.stock || 0, p))}</td>
      <td>${costCell(p)}</td>
      <td>ETB ${fmt(value(p))}</td>
    </tr>`).join('')
  const printHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Stock list</title>
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; padding: 30px; margin: 0; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #c2410c; padding-bottom: 15px; margin-bottom: 20px; }
          .brand { font-size: 24px; font-weight: 800; color: #c2410c; letter-spacing: -0.5px; }
          .subtitle { font-size: 13px; color: #64748b; margin-top: 4px; }
          .meta-box { text-align: right; font-size: 12px; color: #475569; }
          .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 18px; }
          .metric-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; }
          .metric-label { font-size: 11px; color: #64748b; font-weight: 600; text-transform: uppercase; }
          .metric-val { font-size: 18px; font-weight: 700; color: #0f172a; margin-top: 4px; }
          .note { font-size: 11px; color: #64748b; margin: 0 0 14px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th { text-align: left; background: #f1f5f9; padding: 8px 10px; border-bottom: 1px solid #cbd5e1; color: #475569; font-size: 10px; text-transform: uppercase; }
          td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
          td:nth-child(4), td:nth-child(5), .total-row td { white-space: nowrap; }
          tr.no-cost td { color: #b45309; }
          .total-row td { font-weight: 700; background: #f8fafc; border-top: 2px solid #cbd5e1; color: #0f172a; }
          .footer { margin-top: 40px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; }
          @media print { body { padding: 0; } thead { display: table-header-group; } tr { break-inside: avoid; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="brand">MAME INVENTORY & SALES</div>
            <div class="subtitle">Stock list (የክምችት ዝርዝር)</div>
          </div>
          <div class="meta-box">
            <div><b>Gregorian:</b> ${todayGc}</div>
            <div><b>Ethiopian:</b> ${ethToday.monthNameAm} ${ethToday.day}, ${ethToday.year} E.C.</div>
            <div><b>Items:</b> ${products.length}</div>
          </div>
        </div>
        <div class="metrics">
          <div class="metric-card"><div class="metric-label">Items</div><div class="metric-val">${products.length}</div></div>
          <div class="metric-card"><div class="metric-label">Total stock value (ጠቅላላ የክምችት ዋጋ)</div><div class="metric-val">ETB ${fmt(total)}</div></div>
        </div>
        <p class="note">${options.batchesOf ? 'Stock value = what is left of each purchase batch x that batch\'s price (FIFO). Stock entered without a purchase is valued at the item\'s cost price.' : 'Stock value = quantity in stock x cost price per piece (or meter), as entered on the Items page.'}${noCost.length ? ` ${noCost.length} item${noCost.length === 1 ? ' has' : 's have'} stock but no cost price (shown in orange) and count as ETB 0.00.` : ''}</p>
        <table>
          <thead><tr><th>Item</th><th>Category</th><th>Quantity</th><th>${options.batchesOf ? 'In stock at (oldest first)' : 'Cost price'}</th><th>Stock value</th></tr></thead>
          <tbody>
            ${rows || '<tr><td colspan="5" style="text-align:center; color:#94a3b8;">No items yet.</td></tr>'}
            <tr class="total-row"><td colspan="4" style="text-align:right;">Total (${products.length} items)</td><td>ETB ${fmt(total)}</td></tr>
          </tbody>
        </table>
        <div class="footer">Generated automatically by Mame Inventory Operations &bull; ${new Date().toISOString()}</div>
        <script>window.onload = function() { window.print(); }</script>
      </body>
    </html>`
  void deliverPrintable(printHtml, `mame-stock-list-${localISO()}.pdf`)
}
