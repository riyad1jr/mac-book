import { Fragment, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDownToLine,
  ArrowUpRight,
  BarChart3,
  Bell,
  LineChart,
  Boxes,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  Eye,
  EyeOff,
  Home,
  Languages,
  Menu,
  Minus,
  Moon,
  PackagePlus,
  Plus,
  Receipt,
  Search,
  Wallet,
  Settings2,
  ShoppingCart,
  Store,
  Sun,
  Truck,
  Users,
  X,
} from 'lucide-react'

import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, Legend, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts'

import './styles.css'
import './sections.css'
import './sales.css'
import './overview.css'
import './customers.css'
import './reports.css'
import './credit.css'
import './expenses.css'
import './typography.css'
import './layout-fixes.css'
// Using local SaleModal implementation in this file
import type { Product, Purchase, Sale, Customer, Supplier, Expense, LocalAccount, Section } from './types'
import { EthiopianDatePicker } from './components/EthiopianDatePicker'
import { toEthiopianDate, formatDualDate, parseStoredDate } from './utils/ethiopianCalendar'
import { PURCHASE_BY_PIECE, ITEMS_STOCK_PDF, FIFO_COSTING } from './features'
import { computeFifo, stockValueOf, type FifoResult, type Batch } from './utils/fifo'
import { inPeriod as inCalendarPeriod, currentEthMonthLabel, type PeriodKey } from './utils/periods'
import { isRollUnit, isPackUnit, packBreakdown, packUnitName, pluralUnit, baseUnitSymbol, baseUnitWord } from './utils/units'
import { generatePDFReport, generateCustomerPDF, generateExpensesPDF, generateSupplierPDF, generateStockPDF } from './utils/pdfExport'
import { useLanguage, LANGUAGES, tx } from './i18n'
import { useShopData } from './store'
import type { Snapshot, SyncStatus } from './store'
import type { TranslationKey } from './i18n'



const moneyFormatter = new Intl.NumberFormat('en-ET', { style: 'currency', currency: 'ETB', maximumFractionDigits: 2 })
// Intl puts a non-breaking space between 'ETB' and the digits, which stops a
// very large value from ever wrapping at the one safe point. Use a normal
// space; the digits themselves are still kept together by the CSS.
const money = { format: (n: number) => moneyFormatter.format(n).replace(/\u00a0/g, ' ') }
const dateLabel = (date: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00`))
const dateTimeLabel = (date: string, time: string) => `${dateLabel(date)} · ${time}`
const localDate = (date = new Date()) => { const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return offsetDate.toISOString().slice(0, 10) }
const pad2 = (n: number) => String(n).padStart(2, '0')
/** Current local clock time, "HH:MM". */
const localTime = (date = new Date()) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
/**
 * Records saved before this fix stored the time in UTC (toISOString), which
 * is 3 hours behind in Ethiopia, so a 9:30 purchase showed as 06:30. New
 * records are saved in local time and marked tz:'local'; older ones are
 * converted for display and sorting. Stored data is never rewritten.
 */
const shownTime = (record: { date: string; time: string; tz?: 'local' }) => {
  if (!record.time || record.tz === 'local') return record.time || ''
  const at = new Date(`${record.date}T${record.time}:00Z`)
  return Number.isNaN(at.getTime()) ? record.time : localTime(at)
}
const docNumber = (id: string) => Number((/(\d+)\s*$/.exec(id) || [])[1]) || 0
/** Newest first: by date, then time of day, then document number (SO-0012 after SO-0011). */
const newestFirst = (a: { id: string; date: string; time: string; tz?: 'local' }, b: { id: string; date: string; time: string; tz?: 'local' }) =>
  (b.date || '').localeCompare(a.date || '') || shownTime(b).localeCompare(shownTime(a)) || docNumber(b.id) - docNumber(a.id) || b.id.localeCompare(a.id)
type ListSort = 'newest' | 'oldest' | 'highest' | 'lowest'
/** Sort a list of sales or purchases the way the list's sort menu says. */
function sortRecords<T extends { id: string; date: string; time: string; tz?: 'local' }>(rows: T[], order: ListSort, amount: (row: T) => number): T[] {
  const sorted = [...rows]
  if (order === 'newest') return sorted.sort(newestFirst)
  if (order === 'oldest') return sorted.sort((a, b) => newestFirst(b, a))
  if (order === 'highest') return sorted.sort((a, b) => amount(b) - amount(a) || newestFirst(a, b))
  return sorted.sort((a, b) => amount(a) - amount(b) || newestFirst(a, b))
}
/** Pieces (or meters) a purchase added to stock. Purchases are counted in packs unless bought loose. */
const purchaseBaseQty = (purchase: Purchase, product?: Product) => (purchase.buyBy === 'base' ? purchase.quantity : purchase.quantity * (product?.packQty || 1))
/** "pc", "m" or "kg" after a per-unit price. */
const unitSymbolOf = (product?: Product) => (isRollUnit(product?.unit) ? 'm' : /kilo|kg/i.test(product?.unit || '') ? 'kg' : 'pc')
const purchaseTotalCost = (purchase: Purchase) => purchase.totalCost ?? purchase.quantity * purchase.unitCost
// Supplier credit. Purchases recorded before credit existed have no `paid`
// field; they were always treated as paid, so they still are.
const purchasePaid = (purchase: Purchase) => purchase.paid ?? purchaseTotalCost(purchase)
const purchaseOwed = (purchase: Purchase) => Math.max(Math.round((purchaseTotalCost(purchase) - purchasePaid(purchase)) * 100) / 100, 0)
const sameName = (a?: string, b?: string) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()
/** Does this purchase belong to this supplier? By id when recorded, else by name. */
const purchaseIsFrom = (purchase: Purchase, supplier: Supplier) =>
  purchase.supplierId ? purchase.supplierId === supplier.id : sameName(purchase.supplier, supplier.name)
/** What the shop owes each supplier, plus their purchases. A purchase naming a
    supplier with no record of its own still counts, so money owed never drops
    out of view. Used by the Suppliers page and both supplier PDFs. */
function supplierBalances(suppliers: Supplier[], purchases: Purchase[]) {
  const summarise = (supplier: Supplier) => {
    const theirs = purchases.filter((purchase) => purchaseIsFrom(purchase, supplier))
    const open = theirs.filter((purchase) => purchaseOwed(purchase) > 0)
    const dues = open.map((purchase) => purchase.dueDate).filter(Boolean).sort() as string[]
    // From the purchases themselves: older versions never updated the supplier
    // record, so relying on it showed "No purchases yet" for regular suppliers.
    const lastDelivered = theirs.reduce((latest, purchase) => (purchase.date > latest ? purchase.date : latest), supplier.lastDelivered || '')
    return { supplier, purchases: theirs, owed: Math.round(open.reduce((sum, purchase) => sum + purchaseOwed(purchase), 0) * 100) / 100, nextDue: dues[0], lastDelivered }
  }
  const listed = suppliers.map(summarise)
  const orphanNames = Array.from(new Set(purchases
    .filter((purchase) => purchaseOwed(purchase) > 0 && !suppliers.some((supplier) => purchaseIsFrom(purchase, supplier)))
    .map((purchase) => purchase.supplier.trim())))
  const orphans = orphanNames.map((name) => summarise({ id: `orphan-${name}`, name, contact: '', phone: '', email: '', lastDelivered: '' }))
  return [...listed, ...orphans]
}
// Quantity wording lives in ./utils/units so the Items list, the sale
// screen and the PDFs all describe stock the same way.
const stockLabel = (product: Product) => {
  if (isPackUnit(product)) return packBreakdown(product.stock, product)
  if (isRollUnit(product.unit)) return `${Math.floor(product.stock)} rolls`
  return product.stock.toString()
}
const rollUnitName = (product?: Product) => packUnitName(product)
const saleQtyLabel = (base: number, product?: Product) => (isPackUnit(product) ? packBreakdown(base, product) : base.toString())
const purchaseQtyLabel = (purchase: Purchase, product?: Product) => (isPackUnit(product) ? packBreakdown(purchaseBaseQty(purchase, product), product) : purchase.quantity.toString())
const packedQtyLabel = (baseQty: number, product?: Product) => packBreakdown(baseQty, product)
const timeGreeting = () => {
  const now = new Date()
  const hour = now.getHours()
  const partOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  return tx(`Good ${partOfDay}.`)
}

/**
 * Receipt numbers. The old code was `SO-${2085 + sales.length}`, so a brand
 * new shop's very first sale printed as SO-2085 - implying 2,084 earlier
 * sales that never happened - and numbers were reused after a deletion.
 * This continues from the highest number actually issued, starting at 1.
 */
/**
 * Find the product a sale refers to.
 *
 * Sales used to record only the product NAME. If the shop later renamed the
 * product, deleting or editing that sale could not find it, so the stock was
 * never given back - the shop quietly lost inventory. Sales now carry
 * productId; the name lookup remains as a fallback for sales recorded before
 * this change.
 */
function findSaleProduct(products: Product[], sale: { productId?: string; productName: string }): Product | undefined {
  if (sale.productId) {
    const byId = products.find((product) => product.id === sale.productId)
    if (byId) return byId
  }
  return products.find((product) => product.name === sale.productName)
}

/**
 * Next document number for a prefix, continuing from the highest actually
 * issued. Purchases previously used `PO-${1050 + purchases.length}`, so a new
 * shop's first purchase printed as PO-1050 and numbers were reused after a
 * deletion.
 */
function nextDocId(prefix: string, rows: { id: string }[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`)
  let highest = 0
  for (const row of rows) {
    const match = re.exec(String(row.id))
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `${prefix}-${String(highest + 1).padStart(4, '0')}`
}

function nextSaleId(sales: Sale[]): string {
  return nextDocId('SO', sales)
}

function App() {
  const [activeSection, setActiveSection] = useState<Section>('Inventory') // opens on Items
  // Narrow window or heavy zoom (e.g. 200% on a laptop): the sidebar hides and
  // the menu button opens it. The button used to do nothing, leaving no way
  // to move between pages.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  useEffect(() => { setMobileNavOpen(false) }, [activeSection])

  // All business data lives in SQLite via ./store. The setters behave
  // exactly like useState setters; changes are diffed and written for us.
  const data = useShopData()
  const { products, setProducts, purchases, setPurchases, sales, setSales, customers, setCustomers, suppliers, setSuppliers, expenses, setExpenses, branch, setBranch } = data
  // FIFO cost of every sale and the batches still in stock, from the records.
  const fifo = useMemo(() => FIFO_COSTING ? computeFifo(products, purchases, sales, { purchaseQty: purchaseBaseQty, saleProduct: (sale) => findSaleProduct(products, sale), timeOf: shownTime }) : null, [products, purchases, sales])
  // No sign-in: this is a single-shop offline till application. The owner's
  // display name is simply a setting, editable in Settings.
  const currentUser: LocalAccount = { name: data.profileName || 'Shop Owner', email: '', password: '' }
  const [showForm, setShowForm] = useState(false)
  const [query, setQuery] = useState('')
  const [purchasePage, setPurchasePage] = useState(1)
  const [purchasePeriod, setPurchasePeriod] = useState<'daily' | 'weekly' | 'monthly' | 'all'>('all')
  const [purchaseSort, setPurchaseSort] = useState<ListSort>('newest')
  const [toast, setToast] = useState('')
  const [showNotifications, setShowNotifications] = useState(false)
  const [showLang, setShowLang] = useState(false)
  const [form, setForm] = useState({ productId: '', supplier: '', quantity: '1', unitCost: '', reference: '', paymentType: 'paid', paid: '', dueDate: '', buyBy: 'pack' })
  const [selectedPurchase, setSelectedPurchase] = useState<Purchase | null>(null)
  const [editingPurchase, setEditingPurchase] = useState<Purchase | null>(null)
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null)
  const [expenseForm, setExpenseForm] = useState({ category: '', note: '', amount: '' })
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('mame-dark') === 'true')
  const [zoom, setZoom] = useState(() => {
    const saved = Number(localStorage.getItem('mame-zoom'))
    return Number.isFinite(saved) && saved >= 50 && saved <= 200 ? saved : 100
  })
  const { language, setLanguageSafe, t } = useLanguage()

  // Toasts raised from outside React (e.g. the PDF exporter).
  useEffect(() => {
    const onToast = (e: Event) => { setToast(String((e as CustomEvent).detail)); window.setTimeout(() => setToast(''), 4000) }
    window.addEventListener('mame:toast', onToast)
    return () => window.removeEventListener('mame:toast', onToast)
  }, [])

  // Apply zoom through Chromium's own zoom factor in the desktop shell.
  // The old code set the CSS `zoom` property on .app-shell, which does not
  // correctly contain position:fixed children - modals and toasts landed in
  // the wrong place at any zoom other than 100%.
  useEffect(() => {
    localStorage.setItem('mame-zoom', String(zoom))
    if (window.desktop?.setZoom) {
      window.desktop.setZoom(zoom / 100)
    } else {
      // Browser / dev fallback: scale the root font size instead of using
      // CSS zoom, so fixed-position elements stay correct.
      document.documentElement.style.fontSize = `${(zoom / 100) * 16}px`
    }
  }, [zoom])

  useEffect(() => {
    localStorage.setItem('mame-dark', darkMode ? 'true' : '')
  }, [darkMode])

  const filteredPurchases = purchases.filter((purchase) => `${purchase.productName} ${purchase.supplier} ${purchase.reference}`.toLowerCase().includes(query.toLowerCase()))
  const purchaseNow = new Date()
  // Local dates: toISOString() is UTC, so between midnight and 3am in
  // Ethiopia "today" was still yesterday, and the week started a day early.
  const purchaseTodayISO = localDate(purchaseNow)
  const purchaseWeekStart = localDate(new Date(purchaseNow.getFullYear(), purchaseNow.getMonth(), purchaseNow.getDate() - purchaseNow.getDay()))
  const purchaseMonthISO = purchaseTodayISO.slice(0, 7)
  const purchasePeriodKey: PeriodKey = purchasePeriod === 'daily' ? 'day' : purchasePeriod === 'weekly' ? 'week' : purchasePeriod === 'monthly' ? 'month' : 'all'
  const periodPurchases = purchases.filter((purchase) => purchasePeriod === 'all' || inCalendarPeriod(purchase.date, purchasePeriodKey))
  const periodSpend = Math.round(periodPurchases.reduce((sum, purchase) => sum + purchaseTotalCost(purchase), 0) * 100) / 100
  const periodSpendLabel = purchasePeriod === 'all' ? tx('All time') : purchasePeriod === 'daily' ? tx('Today') : purchasePeriod === 'weekly' ? tx('This week') : `${tx('This month')} · ${currentEthMonthLabel()}`
  const owedToSuppliers = Math.round(purchases.reduce((sum, purchase) => sum + purchaseOwed(purchase), 0) * 100) / 100
  const unpaidPurchaseCount = purchases.filter((purchase) => purchaseOwed(purchase) > 0).length
  const scopedPurchases = sortRecords(filteredPurchases, purchaseSort, purchaseTotalCost).filter((purchase) => {
    if (!purchase.date) return true
    return purchasePeriod === 'all' || inCalendarPeriod(purchase.date, purchasePeriodKey)
  })
  const PURCHASE_PAGE_SIZE = 10
  const purchaseTotalPages = Math.max(1, Math.ceil(scopedPurchases.length / PURCHASE_PAGE_SIZE))
  const safePurchasePage = Math.min(purchasePage, purchaseTotalPages)
  const pagePurchases = scopedPurchases.slice((safePurchasePage - 1) * PURCHASE_PAGE_SIZE, safePurchasePage * PURCHASE_PAGE_SIZE)
  const totalSpend = purchases.reduce((sum, purchase) => sum + purchaseTotalCost(purchase), 0)
  const selectedProduct = products.find((product) => product.id === form.productId) ?? products[0]
  const categoryCount = useMemo(() => new Set(products.map((product) => product.category)).size, [products])
  const overdueCount = sales.filter((sale) => sale.dueDate && sale.paid < sale.total && sale.dueDate < localDate()).length

  function submitPurchase(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedProduct) { setToast('Add an item first, then record a purchase'); window.setTimeout(() => setToast(''), 3500); return }
    const quantity = Number(form.quantity)
    const unitCost = Number(form.unitCost)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) return
    const packQty = selectedProduct?.packQty || 1
    // Bought loose (by the piece/meter) or by the pack (carton, roll...).
    const byBase = PURCHASE_BY_PIECE && form.buyBy === 'base' && packQty > 1
    const buyBy: 'base' | undefined = byBase ? 'base' : undefined
    const receivedPcs = byBase ? quantity : quantity * packQty
    const totalCost = receivedPcs * unitCost
    const supplierName = form.supplier.trim() ? form.supplier.trim() : 'Unknown supplier'
    const onCredit = form.paymentType === 'credit'
    if (onCredit && !form.supplier.trim()) {
      setToast('Enter the supplier name: a credit purchase needs to know who is owed')
      window.setTimeout(() => setToast(''), 4000)
      return
    }
    const roundedTotal = Math.round(totalCost * 100) / 100
    const paidNow = onCredit ? Math.min(Math.max(Number(form.paid) || 0, 0), roundedTotal) : roundedTotal
    const dueDate = onCredit && paidNow < roundedTotal && form.dueDate ? form.dueDate : undefined
    // Link the purchase to a supplier record, creating one for a new name so
    // money owed always has somewhere to show up.
    let supplierRecord = form.supplier.trim() ? suppliers.find((item) => sameName(item.name, supplierName)) : undefined
    if (form.supplier.trim() && !supplierRecord) {
      supplierRecord = { id: `sup-${Date.now()}`, name: supplierName, contact: '', phone: '', email: '', lastDelivered: '' }
      const created = supplierRecord
      setSuppliers((current) => [...current, created])
    }
    const date = localDate()
    const time = localTime()

    if (editingPurchase) {
      const oldPurchase = editingPurchase
      // Editing a purchase down (or to another item) takes stock back out.
      // Refuse if that stock was already sold, instead of going below zero.
      const oldProduct = products.find((product) => product.id === oldPurchase.productId)
      if (oldProduct) {
        const after = oldProduct.id === selectedProduct.id
          ? oldProduct.stock + receivedPcs - purchaseBaseQty(oldPurchase, oldProduct)
          : oldProduct.stock - purchaseBaseQty(oldPurchase, oldProduct)
        if (after < 0) {
          setToast(`Can't change ${oldPurchase.reference} like this: some of these ${oldProduct.name} were already sold, so stock would go below zero.`)
          window.setTimeout(() => setToast(''), 5000)
          return
        }
      }
      setPurchases((current) => current.map((purchase) => purchase.id === oldPurchase.id ? {
        ...purchase,
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        supplier: supplierName,
        quantity,
        buyBy,
        unitCost,
        totalCost,
        paid: paidNow,
        dueDate,
        supplierId: supplierRecord?.id,
        reference: form.reference || oldPurchase.reference,
      } : purchase))
      setProducts((current) => current.map((product) => {
        if (product.id === oldPurchase.productId && product.id === selectedProduct.id) {
          return { ...product, stock: product.stock + receivedPcs - purchaseBaseQty(oldPurchase, product), ...(FIFO_COSTING ? {} : { costPrice: unitCost }) }
        }
        if (product.id === oldPurchase.productId && product.id !== selectedProduct.id) {
          return { ...product, stock: product.stock - purchaseBaseQty(oldPurchase, product) }
        }
        if (product.id === selectedProduct.id && product.id !== oldPurchase.productId) {
          return { ...product, stock: product.stock + receivedPcs, ...(FIFO_COSTING ? {} : { costPrice: unitCost }) }
        }
        return product
      }))
      setToast(`Purchase ${oldPurchase.reference} updated`)
      setEditingPurchase(null)
    } else {
      const id = nextDocId('PO', purchases)
      setPurchases((current) => [{ id, productId: selectedProduct.id, productName: selectedProduct.name, supplier: supplierName, supplierId: supplierRecord?.id, quantity, buyBy, unitCost, totalCost, paid: paidNow, dueDate, date, time, tz: 'local', reference: form.reference || id }, ...current])
      setProducts((current) => current.map((product) => product.id === selectedProduct.id ? { ...product, stock: product.stock + receivedPcs, ...(FIFO_COSTING ? {} : { costPrice: unitCost }) } : product))
      setToast(`${selectedProduct.name} stock increased by ${packBreakdown(receivedPcs, selectedProduct)}`)
    }

    if (supplierRecord) {
      const linkedId = supplierRecord.id
      setSuppliers((current) => current.map((item) => item.id === linkedId && (item.lastDelivered || '') < date ? { ...item, lastDelivered: date } : item))
    }
    setShowForm(false)
    setSelectedPurchase(null)
    window.setTimeout(() => setToast(''), 3500)
  }

  function openNewPurchase() {
    // Start clean every time: the form used to reopen with the last purchase's
    // values, and began life with an invented unit cost of 8.50.
    const first = products[0]
    setEditingPurchase(null)
    setForm({ productId: first?.id ?? '', supplier: '', quantity: '1', unitCost: first && !FIFO_COSTING ? String(first.costPrice ?? '') : '', reference: '', paymentType: 'paid', paid: '', dueDate: '', buyBy: 'pack' })
    setShowForm(true)
  }

  function deletePurchase(purchaseId: string) {
    const purchase = purchases.find((item) => item.id === purchaseId)
    if (!purchase) return
    const product = products.find((item) => item.id === purchase.productId)
    const received = purchaseBaseQty(purchase, product)
    if (product && product.stock - received < 0) {
      setToast(`Can't delete ${purchase.reference}: some of these ${product.name} were already sold, so stock would go below zero.`)
      window.setTimeout(() => setToast(''), 5000)
      return
    }
    if (!window.confirm(`Delete purchase ${purchase.reference} (${purchase.productName}, ${money.format(purchaseTotalCost(purchase))})?\n\n${product ? `Stock of ${product.name} goes down by ${packBreakdown(received, product)}.` : ''}`)) return
    setPurchases((current) => current.filter((item) => item.id !== purchaseId))
    setProducts((current) => current.map((product) => product.id === purchase.productId ? { ...product, stock: product.stock - purchaseBaseQty(purchase, product) } : product))
    setToast(`Purchase ${purchase.reference} deleted`)
    setSelectedPurchase(null)
    window.setTimeout(() => setToast(''), 3500)
  }

  function startEditPurchase(purchase: Purchase) {
    setEditingPurchase(purchase)
    setForm({ productId: purchase.productId, supplier: purchase.supplier, quantity: purchase.quantity.toString(), unitCost: purchase.unitCost.toFixed(2), reference: purchase.reference ?? '', paymentType: purchaseOwed(purchase) > 0 ? 'credit' : 'paid', paid: purchasePaid(purchase).toFixed(2), dueDate: purchase.dueDate ?? '', buyBy: purchase.buyBy === 'base' ? 'base' : 'pack' })
    setShowForm(true)
    setSelectedPurchase(null)
  }

  async function resetData() {
    try {
      // Same safety net as a restore: the data about to be cleared becomes a
      // "Before restore" backup, so a mistaken reset can be undone.
      if (window.desktop?.backupBeforeRestore) {
        const safety = await window.desktop.backupBeforeRestore()
        if (!safety.ok) throw new Error(`nothing was cleared, because the current data could not be backed up first (${safety.message ?? 'unknown error'})`)
      }
      await data.replaceAll({ products: [], purchases: [], sales: [], customers: [], suppliers: [], expenses: [] })
      setToast('All data cleared')
    } catch (err) {
      setToast('Could not clear data: ' + (err instanceof Error ? err.message : 'unknown error'))
    }
    window.setTimeout(() => setToast(''), 3500)
  }

  function addSupplier(supplier: { name: string; contact?: string; phone?: string; email?: string }) {
    setSuppliers((prev) => [...prev, { id: `sup-${Date.now()}`, name: supplier.name, contact: supplier.contact ?? '', phone: supplier.phone ?? '', email: supplier.email ?? '', lastDelivered: '' }])
  }

  function submitExpense(event: React.FormEvent) {
    event.preventDefault()
    const amount = Number(expenseForm.amount)
    if (!expenseForm.category.trim() || !Number.isFinite(amount) || amount <= 0) return
    const date = localDate()
    const time = localTime()
    if (editingExpense) {
      setExpenses((current) => current.map((expense) => expense.id === editingExpense.id ? { ...expense, category: expenseForm.category.trim(), note: expenseForm.note.trim(), amount } : expense))
      setToast(`Expense updated`)
    } else {
      setExpenses((current) => [{ id: `exp-${Date.now()}`, category: expenseForm.category.trim(), note: expenseForm.note.trim(), amount, date, time, tz: 'local' }, ...current])
      setToast(`${expenseForm.category.trim()} expense recorded`)
    }
    setShowExpenseForm(false)
    setEditingExpense(null)
    setExpenseForm({ category: '', note: '', amount: '' })
    window.setTimeout(() => setToast(''), 3500)
  }

  function startEditExpense(expense: Expense) {
    setEditingExpense(expense)
    setExpenseForm({ category: expense.category, note: expense.note, amount: expense.amount.toString() })
    setShowExpenseForm(true)
  }

  function deleteExpense(expenseId: string) {
    const expense = expenses.find((item) => item.id === expenseId)
    if (expense && !window.confirm(`Delete this expense (${expense.category}, ${money.format(expense.amount)})?`)) return
    setExpenses((current) => current.filter((expense) => expense.id !== expenseId))
    setToast('Expense deleted')
    window.setTimeout(() => setToast(''), 3500)
  }

  // Close the notifications panel when clicking anywhere else, and close the
  // top-most window (modal) with Escape, like any desktop app.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.notifications-dropdown') && !target.closest('[aria-label="Notifications"]')) setShowNotifications(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const closes = document.querySelectorAll<HTMLButtonElement>('.modal-backdrop .close-button')
      const top = closes[closes.length - 1]
      if (top && !top.disabled) { top.click(); return }
      setShowNotifications(false)
      setMobileNavOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [])

  function toggleNotifications() {
    setShowNotifications(!showNotifications)
  }

  function isDueSoon(s: Sale) {
    if (!s.dueDate) return false
    if (Number(s.paid) >= Number(s.total)) return false
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    return parseStoredDate(s.dueDate) <= soon
  }

  // Computed on every render: the red dot used to update only after the bell
  // was clicked, so a new overdue payment never showed the dot by itself.
  const dueSoonSalesLive = sales.filter(isDueSoon)
  const soonISO = localDate(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))
  const dueSoonPurchases = purchases.filter((p) => p.dueDate && purchaseOwed(p) > 0 && p.dueDate <= soonISO)
  const dueItemsCount = dueSoonSalesLive.length + dueSoonPurchases.length
  const openFromNotification = (section: Section) => { setShowNotifications(false); setActiveSection(section) }
  let notifDrop = null
  if (showNotifications) {
    const items = [
      ...dueSoonSalesLive.map((s) => (
        <li key={s.id}><button type="button" className="notification-item" onClick={() => openFromNotification('Customers')}><b>{s.customer}</b> owes you &mdash; {s.productName}<br /><small>Due: {dateLabel(s.dueDate!)} &middot; Balance: {money.format(s.total - s.paid)}</small></button></li>
      )),
      ...dueSoonPurchases.map((p) => (
        <li key={p.id}><button type="button" className="notification-item" onClick={() => openFromNotification('Suppliers')}><b>You owe {p.supplier}</b> &mdash; {p.productName}<br /><small>Due: {dateLabel(p.dueDate!)} &middot; Owed: {money.format(purchaseOwed(p))}</small></button></li>
      )),
    ]
    const body = items.length === 0 ? <div className="notification-empty">No overdue or due-soon payments</div> : <ul>{items}</ul>
    notifDrop = <div className="notifications-dropdown"><div className="notifications-heading">Due Soon / Overdue</div>{body}</div>
  }

  if (!data.ready) {
    return <StartupScreen dark={darkMode} error={data.loadError} onRetry={data.reload} />
  }

  return (
    <div className={`app-shell${darkMode ? ' dark' : ''}${mobileNavOpen ? ' nav-open' : ''}`}>
      {mobileNavOpen && <div className="nav-scrim" onClick={() => setMobileNavOpen(false)} />}
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Boxes size={20} /></span><span>mame</span></div>
        <div className="workspace-switcher"><span className="workspace-dot">A</span><span><b>Mame</b><small>{tx('Workspace')}</small></span></div>
        <nav className="nav-list" aria-label="Main navigation">
          <NavItem icon={<BarChart3 size={18} />} label={t('nav.overview')} active={activeSection === 'Overview'} onClick={() => setActiveSection('Overview')} />
          <NavItem icon={<ShoppingCart size={18} />} label={t('nav.sales')} active={activeSection === 'Sales'} onClick={() => setActiveSection('Sales')} />
          <NavItem icon={<PackagePlus size={18} />} label={t('nav.purchases')} active={activeSection === 'Purchases'} onClick={() => setActiveSection('Purchases')} />
          <NavItem icon={<Boxes size={18} />} label={t('nav.items')} active={activeSection === 'Inventory'} onClick={() => setActiveSection('Inventory')} />
          <NavItem icon={<Users size={18} />} label={t('nav.customers')} active={activeSection === 'Customers'} onClick={() => setActiveSection('Customers')} />
          <NavItem icon={<Truck size={18} />} label={t('nav.suppliers')} active={activeSection === 'Suppliers'} onClick={() => setActiveSection('Suppliers')} />
          <NavItem icon={<Receipt size={18} />} label={t('nav.expenses')} active={activeSection === 'Expenses'} onClick={() => setActiveSection('Expenses')} />
          <div className="nav-divider" />
          <NavItem icon={<ClipboardList size={18} />} label={t('nav.reports')} active={activeSection === 'Reports'} onClick={() => setActiveSection('Reports')} />
          <NavItem icon={<LineChart size={18} />} label={t('nav.graph')} active={activeSection === 'Graph'} onClick={() => setActiveSection('Graph')} />
          <NavItem icon={<Settings2 size={18} />} label={t('nav.settings')} active={activeSection === 'Settings'} onClick={() => setActiveSection('Settings')} />
        </nav>
        <a className="sidebar-footer" href="https://t.me/rio1jr" target="_blank" rel="noreferrer"><div className="help-icon">?</div><div><b>Need a hand?</b><small>Visit the help center</small></div><ArrowUpRight size={15} /></a>
      </aside>

      <main className="main-content">
        <header className="topbar"><button className="mobile-menu" aria-label="Open menu" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu size={21} /></button><div className="breadcrumb"><span>Operations</span><span>/</span><strong>{activeSection}</strong></div><div className="topbar-actions"><div className="lang-wrap"><button className="lang-button" aria-label={t('topbar.language')} onClick={() => setShowLang(!showLang)}><Languages size={16} />{LANGUAGES.find((l) => l.code === language)?.native}<ChevronDown size={14} /></button>{showLang && <div className="lang-dropdown">{LANGUAGES.map((l) => <button key={l.code} className={`lang-option${l.code === language ? ' active' : ''}`} onClick={() => { setLanguageSafe(l.code); setShowLang(false) }}><b>{l.native}</b><small>{l.label}</small></button>)}</div>}</div><button className="icon-button" aria-label="Notifications" onClick={toggleNotifications}><Bell size={19} />{dueItemsCount > 0 && <span className="badge-dot" />}</button><button className="icon-button" aria-label="Toggle dark mode" onClick={() => setDarkMode(!darkMode)}>{darkMode ? <Sun size={19} /> : <Moon size={19} />}</button><SyncBadge status={data.status} /><span className="topbar-zoom"><button className="icon-button" aria-label="Zoom out" onClick={() => setZoom(Math.max(50, zoom - 10))}><Minus size={17} /></button><button className="topbar-zoom-value" title="Reset zoom" onClick={() => setZoom(100)}>{zoom}%</button><button className="icon-button" aria-label="Zoom in" onClick={() => setZoom(Math.min(200, zoom + 10))}><Plus size={17} /></button></span>{notifDrop}<div className="user-avatar">{currentUser?.name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'U'}</div><span className="user-name">{currentUser?.name || 'User'}</span></div></header>
        <div className="page-wrap">
          {activeSection === 'Inventory' && <InventoryPage products={products} setProducts={setProducts} onBack={() => setActiveSection('Purchases')} t={t} fifo={fifo} />}
          {activeSection === 'Overview' && <OverviewPage products={products} purchases={purchases} sales={sales} onNavigate={setActiveSection} userName={currentUser?.name ?? 'User'} branch={branch} />}
          {activeSection === 'Sales' && <SalesPage products={products} sales={sales} setProducts={setProducts} setSales={setSales} customers={customers} setCustomers={setCustomers} t={t} />}
          {activeSection === 'Customers' && <CustomersPage customers={customers} setCustomers={setCustomers} sales={sales} setSales={setSales} products={products} t={t} />}
          {activeSection === 'Suppliers' && <SuppliersPage suppliers={suppliers} setSuppliers={setSuppliers} onAddSupplier={addSupplier} t={t} purchases={purchases} setPurchases={setPurchases} products={products} />}
          {activeSection === 'Expenses' && <ExpensesPage expenses={expenses} branch={branch} onAdd={() => { setEditingExpense(null); setExpenseForm({ category: '', note: '', amount: '' }); setShowExpenseForm(true) }} onEdit={startEditExpense} onDelete={deleteExpense} t={t} />}
          {activeSection === 'Reports' && <ReportsPage products={products} purchases={purchases} sales={sales} branch={branch} t={t} suppliers={suppliers} fifo={fifo} />}
          {activeSection === 'Graph' && <GraphViewPage products={products} purchases={purchases} sales={sales} t={t} />}
          {activeSection === 'Settings' && <EditableSettingsPage exportSnapshot={data.exportSnapshot} replaceAll={data.replaceAll} currentUser={currentUser} onReset={resetData} darkMode={darkMode} toggleDark={() => setDarkMode(!darkMode)} branch={branch} setBranch={setBranch} profileName={data.profileName} setProfileName={data.setProfileName} address={data.address} setAddress={data.setAddress} t={t} />}
          {activeSection !== 'Purchases' && activeSection !== 'Inventory' && activeSection !== 'Sales' && activeSection !== 'Overview' && activeSection !== 'Customers' && activeSection !== 'Suppliers' && activeSection !== 'Expenses' && activeSection !== 'Reports' && activeSection !== 'Graph' && activeSection !== 'Settings' && <SectionPlaceholder section={activeSection} onBack={() => setActiveSection('Purchases')} />}
          {activeSection === 'Purchases' && <>
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> INVENTORY MANAGEMENT</div><h1>{t('heading.purchases')}</h1><p>{t('heading.purchasesDesc')}</p></div><div className="heading-actions"><div className="branch-picker branch-label" title="Branch name - change it in Settings"><Store size={16} /><span>{branch}</span></div><button className="primary-button" onClick={openNewPurchase}><Plus size={18} /> {t('action.recordPurchase')}</button></div></section>
          <section className="metric-grid"><Metric icon={<CircleDollarSign size={19} />} label={tx('Purchase spend')} value={money.format(periodSpend)} detail={`${periodSpendLabel} · ${periodPurchases.length} ${periodPurchases.length === 1 ? 'order' : 'orders'}`} accent="orange" /><Metric icon={<ArrowDownToLine size={19} />} label={tx('Owed to suppliers')} value={money.format(owedToSuppliers)} detail={owedToSuppliers > 0 ? `${unpaidPurchaseCount} unpaid ${unpaidPurchaseCount === 1 ? 'purchase' : 'purchases'}` : 'Nothing owed'} accent="blue" /><Metric icon={<Boxes size={19} />} label="Active products" value={products.length.toString().padStart(2, '0')} detail={`${categoryCount} categories`} accent="green" /></section>
          <div className="panel purchases-panel"><div className="panel-header"><div><h2>Purchase history</h2><p>Every incoming item, in one place.</p></div><SortSelect value={purchaseSort} onChange={(value) => { setPurchaseSort(value); setPurchasePage(1) }} label="Sort purchases" /></div><div className="table-toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search purchases" value={query} onChange={(event) => { setQuery(event.target.value); setPurchasePage(1) }} placeholder="Search by product, supplier..." /></div><select className="purchase-period-select" aria-label="Purchase period" value={purchasePeriod} onChange={(event) => { setPurchasePeriod(event.target.value as 'daily' | 'weekly' | 'monthly' | 'all'); setPurchasePage(1) }}><option value="all">{tx('All time')}</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div><PurchaseTable purchases={pagePurchases} products={products} onMoreClick={setSelectedPurchase} emptyMessage={purchases.length === 0 ? (products.length === 0 ? 'No purchases yet. Add an item in Items, then click "Record purchase" to log your first order.' : 'No purchases yet. Click "Record purchase" to add your first order.') : t('empty.search')} />{purchaseTotalPages > 1 && <div className="pagination"><button className="secondary-button" disabled={safePurchasePage === 1} onClick={() => setPurchasePage(safePurchasePage - 1)}>{t('common.previous')}</button><span className="pagination-label">{t('common.pageOf')} {safePurchasePage} / {purchaseTotalPages}</span><button className="secondary-button" disabled={safePurchasePage === purchaseTotalPages} onClick={() => setPurchasePage(safePurchasePage + 1)}>{t('common.next')}</button></div>}</div>
          </>}
        </div>
      </main>
      {showForm && <PurchaseModal form={form} setForm={setForm} products={products} onClose={() => { setShowForm(false); setEditingPurchase(null); }} onSubmit={submitPurchase} submitLabel={editingPurchase ? 'Update purchase' : 'Add to stock'} modalTitle={editingPurchase ? 'Edit purchase' : 'Record a purchase'} />}
      {selectedPurchase && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedPurchase(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> PURCHASE ACTIONS</div><h2>{selectedPurchase.productName}</h2><p>{selectedPurchase.reference} · {selectedPurchase.supplier}</p></div><button className="close-button" onClick={() => setSelectedPurchase(null)} aria-label={tx('Close')}><X size={19} /></button></div><div className="modal-body"><div className="action-row"><button className="secondary-button" onClick={() => startEditPurchase(selectedPurchase)}>{tx('Edit')}</button><button className="secondary-button danger" onClick={() => deletePurchase(selectedPurchase.id)}>{tx('Delete')}</button></div></div></div></div>}
      {showExpenseForm && <AddExpenseModal form={expenseForm} setForm={setExpenseForm} editing={editingExpense} onClose={() => { setShowExpenseForm(false); setEditingExpense(null) }} onSubmit={submitExpense} />}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  )
}

function StartupScreen({ dark, error, onRetry }: { dark: boolean; error: string | null; onRetry: () => void }) {
  const [detail, setDetail] = useState<{ error: string | null; logFile: string; port: number } | null>(null)
  useEffect(() => {
    if (!error || !window.desktop?.backendStatus) return
    window.desktop.backendStatus().then((s) => setDetail({ error: s.error, logFile: s.logFile, port: s.port })).catch(() => {})
  }, [error])
  return <div className={`app-shell startup-screen${dark ? ' dark' : ''}`}>
    <div className="startup-card">
      <div className="brand"><span className="brand-mark"><Boxes size={20} /></span><span>mame</span></div>
      {error
        ? <>
            <h2>{tx('Cannot open the shop database')}</h2>
            <p>The local database could not be started. The details below and the log file say why; send them to the person who installed the app.</p>
            <p className="startup-detail">{detail?.error ? detail.error.split('\n').slice(0, 4).join('\n') : error}{detail && !detail.error ? ` (backend reports OK on port ${detail.port} - check antivirus or firewall)` : ''}</p>
            {detail?.logFile && <p className="startup-detail">Log file: {detail.logFile}</p>}
            <div className="modal-actions" style={{ justifyContent: 'center' }}>
              <button className="primary-button" onClick={onRetry}>{tx('Try again')}</button>
              {window.desktop?.openLog && <button className="secondary-button" onClick={() => window.desktop?.openLog()}>Open log file</button>}
            </div>
          </>
        : <>
            <div className="startup-spinner" />
            <p>{tx('Opening your shop data…')}</p>
          </>}
    </div>
  </div>
}

function SyncBadge({ status }: { status: SyncStatus }) {
  const label: Record<SyncStatus, string> = {
    loading: tx('Loading'), ready: tx('Saved'), saving: tx('Saving…'), error: tx('Not saved'), offline: tx('Offline'),
  }
  const title: Record<SyncStatus, string> = {
    loading: 'Loading data from the local database',
    ready: 'All changes are saved to the local database',
    saving: 'Writing changes to the local database',
    error: 'The last change could not be written. It will keep retrying; do not close the app.',
    offline: 'The local database service is not responding',
  }
  return <span className={`sync-badge sync-${status}`} title={title[status]} role="status"><i />{label[status]}</span>
}

/** "Today 14:05", "Yesterday 09:30" or "Sep 27, 2026 14:05", in local time. */
function backupWhen(iso: string | null | undefined) {
  if (!iso) return ''
  const at = new Date(iso)
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const today = localDate()
  const yesterday = localDate(new Date(Date.now() - 86400000))
  const day = localDate(at)
  if (day === today) return `Today ${time}`
  if (day === yesterday) return `Yesterday ${time}`
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} ${time}`
}

function IcloudPanel({ cloud, busy, onBackupNow }: { cloud: IcloudStatus; busy: boolean; onBackupNow: () => void }) {
  let tone: 'ok' | 'warn' = 'ok'
  let headline = ''
  let help: React.ReactNode = null
  if (!cloud.available) {
    tone = 'warn'
    headline = 'iCloud Drive is off on this Mac'
    help = <>To turn it on: <b>System Settings → your name → iCloud → iCloud Drive → On</b>. Until then, backups are still saved on this Mac.</>
  } else if (cloud.lastError && cloud.lastErrorKind === 'permission') {
    tone = 'warn'
    headline = 'macOS blocked access to iCloud Drive'
    help = <>Open <b>System Settings → Privacy &amp; Security → Files and Folders → Mame Inventory</b> and turn on <b>iCloud Drive</b>. Then press Back up now.</>
  } else if (cloud.lastError && cloud.lastErrorKind === 'full') {
    tone = 'warn'
    headline = 'No space left for the iCloud copy'
    help = <>Free some space on this Mac or in iCloud, then press Back up now.</>
  } else if (cloud.lastError) {
    tone = 'warn'
    headline = 'The last iCloud copy failed'
    help = <>{cloud.lastError} Backups are still saved on this Mac.</>
  } else if (cloud.lastCopiedAt) {
    headline = `Last copied to iCloud: ${backupWhen(cloud.lastCopiedAt)}`
    help = <>{cloud.copies} {cloud.copies === 1 ? 'copy' : 'copies'} in iCloud Drive → Mame Backups.</>
  } else {
    headline = 'On — waiting for the first copy'
    help = <>The first copy is made about a minute after the app opens. You can also press Back up now.</>
  }
  return <div className="panel settings-panel icloud-panel">
    <div className="panel-header"><div><h2>{tx('iCloud backup')}</h2><p>Your data stays on this Mac. A copy of every backup also goes to iCloud Drive, so nothing is lost if the Mac is lost or breaks.</p></div></div>
    <div className={`icloud-status ${tone}`} role="status"><span className="icloud-dot" aria-hidden="true" /><div><b>{headline}</b><small>{help}</small></div></div>
    <div className="modal-actions">
      <button type="button" className="secondary-button" onClick={onBackupNow} disabled={busy}>{tx('Back up now')}</button>
      {cloud.available && <button type="button" className="secondary-button" onClick={() => window.desktop?.openIcloudFolder()}>{tx('Show in Finder')}</button>}
    </div>
    <p className="form-message" style={{ color: 'var(--muted)' }}>Copies are made every hour while the app is open (when something changed) and when you quit. iCloud keeps the latest 48 and one per day for 60 days.</p>
  </div>
}

const COLLECTION_LABELS: [string, string][] = [['products', 'items'], ['sales', 'sales'], ['purchases', 'purchases'], ['customers', 'customers'], ['suppliers', 'suppliers'], ['expenses', 'expenses']]

function RestoreBackupModal({ onClose, replaceAll, onDone }: { onClose: () => void; replaceAll: (snapshot: Partial<Snapshot>) => Promise<void>; onDone: (message: string) => void }) {
  const [list, setList] = useState<BackupEntry[] | null>(null)
  const [picked, setPicked] = useState('')
  const [preview, setPreview] = useState<Awaited<ReturnType<DesktopApi['readBackup']>> | null>(null)
  const [working, setWorking] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    window.desktop?.listBackups().then((rows) => { setList(rows); if (rows[0]) setPicked(rows[0].name) }).catch((err) => setError(String(err)))
  }, [])

  async function openPicked() {
    if (!picked || !window.desktop) return
    setError('')
    setWorking('Opening the backup…')
    try {
      const result = await window.desktop.readBackup(picked)
      if (!result.ok) setError(result.message || 'Could not open this backup.')
      else setPreview(result)
    } finally {
      setWorking('')
    }
  }

  async function restore() {
    if (!preview?.snapshot || !window.desktop) return
    setError('')
    setWorking('Saving your current data first…')
    try {
      // Safety net: what is in the app right now becomes a backup of its own,
      // so a wrong choice can be undone by restoring that one.
      const safety = await window.desktop.backupBeforeRestore()
      if (!safety.ok) { setError(`Nothing was changed: the current data could not be saved first (${safety.message ?? 'unknown error'}).`); return }
      setWorking('Restoring…')
      await replaceAll(preview.snapshot as Partial<Snapshot>)
      onDone(`Restored the backup from ${backupWhen(preview.time)}. The data you had before is saved as a backup marked "Before restore", so this can be undone.`)
      onClose()
    } catch (err) {
      setError(`The restore did not finish: ${err instanceof Error ? err.message : String(err)}. Your data from before was saved as a backup marked "Before restore".`)
    } finally {
      setWorking('')
    }
  }

  const where = (row: BackupEntry) => (row.local && row.cloud ? 'iCloud + this computer' : row.cloud ? (row.cloudPlaceholder ? 'iCloud (downloads when chosen)' : 'iCloud') : 'This computer')
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !working && onClose()}><div className="modal wide-modal restore-modal">
    <div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> RESTORE</div><h2>{tx('Restore from backup')}</h2><p>Pick a backup. You will see what it contains before anything is changed.</p></div><button className="close-button" onClick={onClose} disabled={Boolean(working)} aria-label={tx('Close')}><X size={19} /></button></div>
    {!preview && <>
      {list === null && !error && <p className="form-message">Looking for backups…</p>}
      {list && list.length === 0 && <p className="empty-state">No backups found yet. Backups are made automatically about a minute after the app opens.</p>}
      {list && list.length > 0 && <div className="restore-list" role="radiogroup" aria-label="Backups">
        {list.map((row) => <label key={row.name} className={`restore-row${picked === row.name ? ' selected' : ''}`}>
          <input type="radio" name="backup" value={row.name} checked={picked === row.name} onChange={() => setPicked(row.name)} />
          <span><b>{backupWhen(row.time)}</b>{row.beforeRestore && <em className="restore-tag">Before restore</em>}<small>{where(row)}{row.size ? ` · ${row.size >= 1024 * 1024 ? `${(row.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(row.size / 1024))} KB`}` : ''}</small></span>
        </label>)}
      </div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={Boolean(working)}>{tx('Cancel')}</button><button type="button" className="primary-button" onClick={openPicked} disabled={!picked || Boolean(working)}>{working || tx('Next')}</button></div>
    </>}
    {preview?.ok && <>
      <div className="restore-preview">
        <b>Backup from {backupWhen(preview.time)}</b>
        <p>It contains {COLLECTION_LABELS.map(([key, label]) => `${(preview.counts?.[key] ?? 0).toLocaleString()} ${label}`).join(', ')}.</p>
        <p className="warn-note">Everything currently in the app will be replaced with this backup. Your current data is saved first as a backup marked "Before restore", so you can undo this.</p>
      </div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setPreview(null)} disabled={Boolean(working)}>{tx('Back')}</button><button type="button" className="primary-button" onClick={restore} disabled={Boolean(working)}>{working || tx('Restore this backup')}</button></div>
    </>}
    {error && <p className="form-message warn-note" role="alert">{error}</p>}
  </div></div>
}

/** A sort menu with page-specific choices (Customers, Suppliers, Items). */
function SortMenu<T extends string>({ value, onChange, label, options }: { value: T; onChange: (value: T) => void; label: string; options: [T, string][] }) {
  return <select className="purchase-period-select sort-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
    {options.map(([key, text]) => <option key={key} value={key}>{tx(text)}</option>)}
  </select>
}
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

function SortSelect({ value, onChange, label }: { value: ListSort; onChange: (value: ListSort) => void; label: string }) {
  return <select className="purchase-period-select sort-select" aria-label={label} value={value} onChange={(event) => onChange(event.target.value as ListSort)}>
    <option value="newest">{tx('Newest first')}</option>
    <option value="oldest">{tx('Oldest first')}</option>
    <option value="highest">{tx('Highest amount')}</option>
    <option value="lowest">{tx('Lowest amount')}</option>
  </select>
}
function NavItem({ icon, label, active, count, onClick }: { icon: React.ReactNode; label: string; active?: boolean; count?: string; onClick: () => void }) { return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{count && <em>{count}</em>}</button> }
function OverviewPage({ products, purchases, sales, onNavigate, userName, branch }: { products: Product[]; purchases: Purchase[]; sales: Sale[]; onNavigate: (section: Section) => void; userName: string; branch: string }) {
  // Figures start hidden every time; they show only after "Show figures" is clicked.
  const [hideValues, setHideValues] = useState(true)
  const mask = (v: string) => hideValues ? '••••••' : v
  const salesTotal = sales.reduce((sum, sale) => sum + sale.total, 0)
  const purchaseTotal = purchases.reduce((sum, purchase) => sum + purchaseTotalCost(purchase), 0)
  const creditTotal = sales.reduce((sum, sale) => sum + Math.max(sale.total - sale.paid, 0), 0)
  const greeting = timeGreeting()
  const activity = [
    ...sales.map((sale) => ({ id: sale.id, title: sale.productName, detail: `${sale.customer} · sale`, amount: sale.total, date: sale.date, time: sale.time, tz: sale.tz, kind: 'sale' })),
    ...purchases.map((purchase) => ({ id: purchase.id, title: purchase.productName, detail: `${purchase.supplier} · purchase`, amount: purchaseTotalCost(purchase), date: purchase.date, time: purchase.time, tz: purchase.tz, kind: 'purchase' })),
  ].sort((left, right) => newestFirst(left, right)).slice(0, 5)

  return <section className="overview-page"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE OVERVIEW</div><h1>{greeting}</h1><p>{tx('Here is what is moving across your operation.')}</p></div><div className="heading-actions"><button className="secondary-button figures-toggle" aria-pressed={!hideValues} onClick={() => setHideValues(!hideValues)}>{hideValues ? <Eye size={17} /> : <EyeOff size={17} />} {hideValues ? tx('Show figures') : tx('Hide figures')}</button><div className="branch-picker branch-label" title="Branch name - change it in Settings"><Store size={16} /> {branch}</div></div></section><section className="metric-grid overview-metrics"><Metric icon={<CircleDollarSign size={19} />} label={tx('Sales revenue')} value={mask(money.format(salesTotal))} detail={tx('Recorded sales')} accent="orange" /><Metric icon={<PackagePlus size={19} />} label={tx('Purchase spend')} value={mask(money.format(purchaseTotal))} detail={tx('Incoming stock')} accent="blue" /><Metric icon={<Users size={19} />} label={tx('Customer credit')} value={mask(money.format(creditTotal))} detail={tx('Outstanding balance')} accent="red" /></section><div className="overview-grid"><div className="panel activity-panel"><div className="panel-header"><div><h2>{tx('Recent activity')}</h2><p>{tx('Sales and purchases across your workspace.')}</p></div></div><div className="activity-list">{activity.length === 0 && <div className="empty-state">No sales or purchases yet. They will show here as you record them.</div>}{activity.map((item) => <div className="activity-row" key={item.id}><div className={`activity-icon ${item.kind}`}>{item.kind === 'sale' ? <ShoppingCart size={16} /> : <PackagePlus size={16} />}</div><div className="activity-copy"><b>{item.title}</b><small>{item.detail} · {dateLabel(item.date)}</small></div><strong>{item.kind === 'sale' ? '+' : '-'}{mask(money.format(item.amount))}</strong></div>)}</div></div><div className="overview-side"><div className="panel quick-panel"><div className="panel-header compact"><div><h2>{tx('Quick actions')}</h2><p>{tx('Jump into a daily workflow.')}</p></div></div><button className="quick-action" onClick={() => onNavigate('Sales')}><ShoppingCart size={17} /><span><b>{tx('Record a sale')}</b><small>{tx('Sell stock and take payment')}</small></span><ArrowUpRight size={15} /></button><button className="quick-action" onClick={() => onNavigate('Purchases')}><PackagePlus size={17} /><span><b>{tx('Record a purchase')}</b><small>{tx('Bring new stock into the branch')}</small></span><ArrowUpRight size={15} /></button><button className="quick-action" onClick={() => onNavigate('Inventory')}><Boxes size={17} /><span><b>{tx('Manage inventory')}</b><small>{tx('Add items and check stock')}</small></span><ArrowUpRight size={15} /></button></div></div></div></section>
}
function CustomersPage({ customers, setCustomers, sales, setSales, products, t }: { customers: Customer[]; setCustomers: React.Dispatch<React.SetStateAction<Customer[]>>; sales: Sale[]; setSales: React.Dispatch<React.SetStateAction<Sale[]>>; products: Product[]; t: (k: TranslationKey) => string }) {
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [query, setQuery] = useState('')
  const [customer, setCustomer] = useState({ name: '', phone: '+251 ', email: '' })
  const [payingCustomer, setPayingCustomer] = useState<{ name: string; credit: number } | null>(null)
  const [partialAmount, setPartialAmount] = useState('')
  // Row menu (•••): it used to be a button with nothing behind it.
  const [actionCustomer, setActionCustomer] = useState<Customer | null>(null)
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null)
  const [editForm, setEditForm] = useState({ name: '', phone: '', email: '' })
  const [customerNotice, setCustomerNotice] = useState('')
  const customerStats = (name: string) => { const customerSales = sales.filter((sale) => sameName(sale.customer, name)); return { sales: customerSales.length, credit: customerSales.reduce((sum, sale) => sum + Math.max(sale.total - sale.paid, 0), 0), spent: customerSales.reduce((sum, sale) => sum + sale.total, 0) } }
  const [customerSort, setCustomerSort] = useState<'name' | 'owes' | 'spent' | 'newest'>('name')
  const visibleCustomers = customers
    .filter((item) => `${item.name} ${item.phone} ${item.email}`.toLowerCase().includes(query.toLowerCase()))
    .map((item) => ({ item, stats: customerStats(item.name) }))
    .sort((a, b) => customerSort === 'owes' ? b.stats.credit - a.stats.credit || byName(a.item.name, b.item.name)
      : customerSort === 'spent' ? b.stats.spent - a.stats.spent || byName(a.item.name, b.item.name)
      : customerSort === 'newest' ? (b.item.createdAt || '').localeCompare(a.item.createdAt || '') || docNumber(b.item.id) - docNumber(a.item.id)
      : byName(a.item.name, b.item.name))
    .map(({ item }) => item)

  function payCustomerCreditFull(name: string) {
    setSales((current) => current.map((sale) => sameName(sale.customer, name) ? { ...sale, paid: sale.total, dueDate: undefined } : sale))
  }

  function payCustomerCreditPartial(name: string, amount: number) {
    setSales((current) => {
      let remaining = amount
      const customerSales = current
        .filter((sale) => sameName(sale.customer, name) && sale.total > sale.paid)
        .sort((a, b) => a.date.localeCompare(b.date))
      const updates = new Map<string, number>()
      for (const sale of customerSales) {
        if (remaining <= 0) break
        const owed = sale.total - sale.paid
        const payment = Math.min(owed, remaining)
        remaining -= payment
        updates.set(sale.id, sale.paid + payment)
      }
      return current.map((sale) => {
        if (!updates.has(sale.id)) return sale
        const newPaid = updates.get(sale.id)!
        return { ...sale, paid: newPaid, dueDate: newPaid >= sale.total ? undefined : sale.dueDate }
      })
    })
  }

  function confirmCreditPayment() {
    if (!payingCustomer) return
    const amt = Number(partialAmount)
    if (partialAmount !== '' && Number.isFinite(amt) && amt > 0) {
      payCustomerCreditPartial(payingCustomer.name, amt)
    } else {
      payCustomerCreditFull(payingCustomer.name)
    }
    setPayingCustomer(null)
    setPartialAmount('')
  }

  const totalCredit = customers.reduce((sum, item) => sum + customerStats(item.name).credit, 0)

  function startEditCustomer(item: Customer) {
    setActionCustomer(null)
    setCustomerNotice('')
    setEditForm({ name: item.name, phone: item.phone || '', email: item.email || '' })
    setEditingCustomer(item)
  }

  function saveCustomer(event: React.FormEvent) {
    event.preventDefault()
    if (!editingCustomer) return
    const name = editForm.name.trim()
    if (!name) return
    if (customers.some((other) => other.id !== editingCustomer.id && other.name.trim().toLowerCase() === name.toLowerCase())) {
      setCustomerNotice(`There is already a customer called "${name}". Use a different name.`)
      return
    }
    const oldName = editingCustomer.name
    setCustomers((current) => current.map((item) => item.id === editingCustomer.id ? { ...item, name, phone: editForm.phone.trim(), email: editForm.email.trim() } : item))
    // Sales are linked to a customer by name, so a rename carries their
    // history (and any credit they owe) along with it.
    if (name !== oldName) setSales((current) => current.map((sale) => sameName(sale.customer, oldName) ? { ...sale, customer: name } : sale))
    setEditingCustomer(null)
  }

  function deleteCustomer(item: Customer) {
    const stats = customerStats(item.name)
    if (stats.credit > 0) {
      setCustomerNotice(`${item.name} still owes ${money.format(stats.credit)}. Record the payment first, so that money is not lost from view.`)
      return
    }
    const note = stats.sales > 0 ? `\n\nTheir ${stats.sales} past sale${stats.sales === 1 ? '' : 's'} stay in Sales and reports.` : ''
    if (!window.confirm(`Delete the customer "${item.name}"?${note}`)) return
    setCustomers((current) => current.filter((other) => other.id !== item.id))
    setActionCustomer(null)
  }

  function addCustomer(event: React.FormEvent) {
    event.preventDefault()
    if (!customer.name.trim()) return
    const phone = customer.phone.trim().startsWith('+251') ? customer.phone.trim() : `+251 ${customer.phone.trim()}`
    setCustomers((current) => [...current, { id: `c-${Date.now()}`, name: customer.name.trim(), phone, email: customer.email.trim(), createdAt: localDate() }])
    setCustomer({ name: '', phone: '+251 ', email: '' })
    setShowAddCustomer(false)
  }

  return <section className="customers-page"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> CUSTOMER ACCOUNTS</div><h1>{t('heading.customers')}</h1><p>{t('heading.customersDesc')}</p></div><button className="primary-button" onClick={() => setShowAddCustomer(true)}><Plus size={18} /> {t('action.addCustomer')}</button></section><section className="metric-grid customer-metrics"><Metric icon={<Users size={19} />} label="Total customers" value={customers.length.toString().padStart(2, '0')} detail="Active accounts" accent="green" /><Metric icon={<CircleDollarSign size={19} />} label={tx('Credit outstanding')} value={money.format(totalCredit)} detail="Needs collection" accent="red" /><Metric icon={<ShoppingCart size={19} />} label="Customer sales" value={sales.length.toString()} detail="Recorded transactions" accent="blue" /></section><div className="panel customers-panel"><div className="panel-header"><div><h2>Customer directory</h2><p>Search accounts and review their current balance.</p></div></div><div className="table-toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search customers" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, phone, or email..." /></div><SortMenu value={customerSort} onChange={setCustomerSort} label="Sort customers" options={[['name', 'Name A–Z'], ['owes', 'Owes the most'], ['spent', 'Spent the most'], ['newest', 'Newest customer']]} /><span className="directory-count">{visibleCustomers.length} shown</span></div><div className="table-wrap"><table><thead><tr><th>{tx('Customer')}</th><th>{tx('Phone')}</th><th>{tx('Sales')}</th><th>Total spent</th><th>{tx('Credit balance')}</th><th /></tr></thead><tbody>{visibleCustomers.map((item) => { const stats = customerStats(item.name); return <tr key={item.id}><td><div className="purchase-product"><div className="customer-avatar">{item.name.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><b>{item.name}</b><small>{item.email || 'No email added'}</small></div></div></td><td>{item.phone || 'Not provided'}</td><td>{stats.sales}</td><td><b>{money.format(stats.spent)}</b></td><td><span className={stats.credit > 0 ? 'credit-pill' : 'paid-pill'}>{stats.credit > 0 ? money.format(stats.credit) : 'Settled'}</span></td><td><div className="row-actions">{stats.credit > 0 && <button className="secondary-button" onClick={() => setPayingCustomer({ name: item.name, credit: stats.credit })}>Pay Credit</button>}<button className="more-button" aria-label={`Actions for ${item.name}`} onClick={() => { setCustomerNotice(''); setActionCustomer(item) }}>•••</button><button className="more-button" title="Export PDF report" onClick={() => generateCustomerPDF({ customer: item, sales: sales.filter((s) => sameName(s.customer, item.name)), products })}>PDF</button></div></td></tr> })}</tbody></table>{visibleCustomers.length === 0 && <div className="empty-state">No customers match your search.</div>}</div></div>{showAddCustomer && <AddCustomerModal customer={customer} setCustomer={setCustomer} onClose={() => setShowAddCustomer(false)} onSubmit={addCustomer} />}{actionCustomer && (() => { const stats = customerStats(actionCustomer.name); return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setActionCustomer(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> CUSTOMER ACTIONS</div><h2>{actionCustomer.name}</h2><p>{actionCustomer.phone || 'No phone'} · {stats.sales} sale{stats.sales === 1 ? '' : 's'}{stats.credit > 0 ? ` · owes ${money.format(stats.credit)}` : ''}</p></div><button className="close-button" onClick={() => setActionCustomer(null)} aria-label={tx('Close')}><X size={19} /></button></div><div className="modal-body"><div className="action-row"><button className="secondary-button" onClick={() => startEditCustomer(actionCustomer)}>{tx('Edit')}</button><button className="secondary-button danger" onClick={() => deleteCustomer(actionCustomer)}>{tx('Delete')}</button></div>{customerNotice && <p className="form-message warn-note" role="alert">{customerNotice}</p>}</div></div></div> })()}{editingCustomer && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditingCustomer(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> EDIT CUSTOMER</div><h2>{editingCustomer.name}</h2><p>Changing the name also updates this customer's past sales and credit.</p></div><button className="close-button" onClick={() => setEditingCustomer(null)} aria-label={tx('Close')}><X size={19} /></button></div><form onSubmit={saveCustomer}><label>{tx('Customer name')}<input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></label><label>{tx('Phone number')}<input value={editForm.phone} onChange={(event) => setEditForm({ ...editForm, phone: event.target.value })} /></label><label>{tx('Email address')}<input type="email" value={editForm.email} onChange={(event) => setEditForm({ ...editForm, email: event.target.value })} /></label>{customerNotice && <p className="form-message warn-note" role="alert">{customerNotice}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditingCustomer(null)}>{tx('Cancel')}</button><button type="submit" className="primary-button">{tx('Save changes')}</button></div></form></div></div>}{payingCustomer && <CreditPaymentModal customerName={payingCustomer.name} credit={payingCustomer.credit} partialAmount={partialAmount} setPartialAmount={setPartialAmount} onClose={() => { setPayingCustomer(null); setPartialAmount(''); }} onConfirm={confirmCreditPayment} />}</section>
}

function SuppliersPage({ suppliers, setSuppliers, onAddSupplier, t, purchases, setPurchases, products }: { products: Product[]; suppliers: Supplier[]; setSuppliers: React.Dispatch<React.SetStateAction<Supplier[]>>; onAddSupplier: (supplier: { name: string; contact?: string; phone?: string; email?: string }) => void; t: (k: TranslationKey) => string; purchases: Purchase[]; setPurchases: React.Dispatch<React.SetStateAction<Purchase[]>> }) {
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ name: '', contact: '', phone: '', email: '' })
  const [paying, setPaying] = useState<{ supplier: Supplier; owed: number } | null>(null)
  const [payAmount, setPayAmount] = useState('')
  // Row menu (•••): suppliers had no way to be edited or deleted at all.
  const [actionRow, setActionRow] = useState<{ supplier: Supplier; owed: number; count: number } | null>(null)
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null)
  const [editForm, setEditForm] = useState({ name: '', contact: '', phone: '', email: '' })
  const [supplierNotice, setSupplierNotice] = useState('')
  const isListed = (supplier: Supplier) => suppliers.some((item) => item.id === supplier.id)

  function startEditSupplier(supplier: Supplier) {
    setActionRow(null)
    setSupplierNotice('')
    setEditForm({ name: supplier.name, contact: supplier.contact || '', phone: supplier.phone || '', email: supplier.email || '' })
    setEditingSupplier(supplier)
  }

  function saveSupplier(event: React.FormEvent) {
    event.preventDefault()
    if (!editingSupplier) return
    const name = editForm.name.trim()
    if (!name) return
    if (suppliers.some((other) => other.id !== editingSupplier.id && sameName(other.name, name))) {
      setSupplierNotice(`There is already a supplier called "${name}". Use a different name.`)
      return
    }
    const target = editingSupplier
    // A supplier that only appeared on purchases (no record yet) gets one now.
    const id = isListed(target) ? target.id : `sup-${Date.now()}`
    const saved: Supplier = { ...target, id, name, contact: editForm.contact.trim(), phone: editForm.phone.trim(), email: editForm.email.trim() }
    setSuppliers((current) => isListed(target) ? current.map((item) => item.id === id ? saved : item) : [...current, saved])
    // Purchases carry the supplier's name; keep it in step and link them by id,
    // so the balance owed and the PDF follow the supplier after a rename.
    setPurchases((current) => current.map((purchase) => purchaseIsFrom(purchase, target) ? { ...purchase, supplier: name, supplierId: id } : purchase))
    setEditingSupplier(null)
  }

  function deleteSupplier(row: { supplier: Supplier; owed: number; count: number }) {
    if (row.owed > 0) {
      setSupplierNotice(`The shop still owes ${row.supplier.name} ${money.format(row.owed)}. Record the payment first, so that debt is not lost from view.`)
      return
    }
    const note = row.count > 0 ? `\n\nThe ${row.count} purchase${row.count === 1 ? '' : 's'} from them stay in Purchases and reports.` : ''
    if (!window.confirm(`Delete the supplier "${row.supplier.name}"?${note}`)) return
    const target = row.supplier
    setSuppliers((current) => current.filter((item) => item.id !== target.id))
    // Unlink (keep the name) so a supplier added later with the same name
    // still finds these purchases.
    setPurchases((current) => current.map((purchase) => purchase.supplierId === target.id ? { ...purchase, supplierId: undefined } : purchase))
    setActionRow(null)
  }

  // What the shop owes each supplier. A purchase naming a supplier that has
  // no record of its own still counts, so money owed can never drop out of view.
  const [supplierQuery, setSupplierQuery] = useState('')
  const [supplierSort, setSupplierSort] = useState<'name' | 'owed' | 'recent'>('name')
  const rows = useMemo(() => supplierBalances(suppliers, purchases), [suppliers, purchases])
  const needle = supplierQuery.trim().toLowerCase()
  const shownRows = rows
    .filter((row) => !needle || `${row.supplier.name} ${row.supplier.contact} ${row.supplier.phone} ${row.supplier.email}`.toLowerCase().includes(needle))
    .sort((a, b) => supplierSort === 'owed' ? b.owed - a.owed || byName(a.supplier.name, b.supplier.name)
      : supplierSort === 'recent' ? (b.lastDelivered || '').localeCompare(a.lastDelivered || '') || byName(a.supplier.name, b.supplier.name)
      : byName(a.supplier.name, b.supplier.name))
  const totalOwed = Math.round(rows.reduce((sum, row) => sum + row.owed, 0) * 100) / 100
  const latestRow = rows.reduce<(typeof rows)[number] | null>((latest, row) => (row.lastDelivered && (!latest || row.lastDelivered > latest.lastDelivered) ? row : latest), null)
  const today = localDate()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!form.name.trim()) return
    onAddSupplier({
      name: form.name.trim(),
      contact: form.contact.trim() || undefined,
      phone: form.phone.trim() || undefined,
      email: form.email.trim() || undefined,
    })
    setForm({ name: '', contact: '', phone: '', email: '' })
    setShowAdd(false)
  }

  // Pays off the oldest purchases first, like customer credit does.
  function paySupplier(target: Supplier, amount: number) {
    setPurchases((current) => {
      let remaining = Math.round(amount * 100) / 100
      const open = current
        .filter((purchase) => purchaseIsFrom(purchase, target) && purchaseOwed(purchase) > 0)
        .sort((x, y) => `${x.date} ${x.time}`.localeCompare(`${y.date} ${y.time}`) || x.id.localeCompare(y.id))
      const newPaid = new Map<string, number>()
      for (const purchase of open) {
        if (remaining <= 0) break
        const payment = Math.min(purchaseOwed(purchase), remaining)
        remaining = Math.round((remaining - payment) * 100) / 100
        newPaid.set(purchase.id, Math.round((purchasePaid(purchase) + payment) * 100) / 100)
      }
      return current.map((purchase) => {
        if (!newPaid.has(purchase.id)) return purchase
        const paid = newPaid.get(purchase.id)!
        return { ...purchase, paid, dueDate: paid >= purchaseTotalCost(purchase) ? undefined : purchase.dueDate }
      })
    })
  }

  function confirmPayment(event: React.FormEvent) {
    event.preventDefault()
    if (!paying) return
    const amount = Number(payAmount)
    if (!Number.isFinite(amount) || amount <= 0) return
    paySupplier(paying.supplier, Math.min(amount, paying.owed))
    setPaying(null)
    setPayAmount('')
  }

  return (
    <section className="suppliers-page">
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SUPPLY NETWORK</div><h1>{t('heading.suppliers')}</h1><p>{t('heading.suppliersDesc')}</p></div><div className="heading-actions"><button className="primary-button" onClick={() => setShowAdd(true)}><Plus size={18} /> {t('action.addSupplier')}</button></div></section>
      <section className="metric-grid supplier-metrics">
        <Metric icon={<Truck size={19} />} label={tx('Suppliers')} value={suppliers.length.toString()} detail="Vendors on record" accent="green" />
        <Metric icon={<CircleDollarSign size={19} />} label={tx('Owed to suppliers')} value={money.format(totalOwed)} detail={totalOwed > 0 ? `${rows.filter((row) => row.owed > 0).length} unpaid` : 'Nothing owed'} accent="red" />
        <Metric icon={<CircleDollarSign size={19} />} label={tx('Last delivered')} value={latestRow?.lastDelivered || '—'} detail={latestRow ? latestRow.supplier.name : 'No purchases yet'} accent="orange" />
      </section>
      <div className="panel suppliers-panel"><div className="panel-header"><div><h2>Supplier directory</h2><p>Contacts, most recent delivery and what the shop still owes each supplier.</p></div></div><div className="table-toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search suppliers" value={supplierQuery} onChange={(event) => setSupplierQuery(event.target.value)} placeholder="Search name, contact or phone..." /></div><SortMenu value={supplierSort} onChange={setSupplierSort} label="Sort suppliers" options={[['name', 'Name A–Z'], ['owed', 'Owed the most'], ['recent', 'Last delivered']]} /></div><div className="table-wrap"><table><thead><tr><th>{tx('Supplier')}</th><th>{tx('Contact person')}</th><th>{tx('Phone')}</th><th>{tx('Last delivered')}</th><th>{tx('Owed')}</th><th /></tr></thead><tbody>
        {rows.length === 0 ? <tr><td colSpan={6}><em>No suppliers yet. Add one, or record a purchase with a supplier's name.</em></td></tr> : shownRows.length === 0 ? <tr><td colSpan={6}><em>No suppliers match your search.</em></td></tr> : shownRows.map(({ supplier, owed, nextDue, lastDelivered, purchases: theirs }) => <tr key={supplier.id}>
          <td><div className="purchase-product"><div className="mini-product">{supplier.name.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><b>{supplier.name}</b>{supplier.email && <small>{supplier.email}</small>}</div></div></td>
          <td>{supplier.contact || '—'}</td>
          <td>{supplier.phone || '—'}</td>
          <td>{lastDelivered || '—'}</td>
          <td>{owed > 0 ? <><span className="credit-pill">{money.format(owed)}</span>{nextDue && <small className={nextDue < today ? 'due-note overdue' : 'due-note'}>{nextDue < today ? 'Overdue since' : 'Due'} {nextDue}</small>}</> : <span className="paid-pill">{tx('Paid')}</span>}</td>
          <td><div className="row-actions">{owed > 0 && <button className="detail-button" onClick={() => { setPaying({ supplier, owed }); setPayAmount(owed.toFixed(2)) }}>{tx('Pay supplier')}</button>}<button className="detail-button" title="Export PDF statement" aria-label={`PDF statement for ${supplier.name}`} onClick={() => generateSupplierPDF({ supplier, purchases: theirs, products })}>PDF</button><button className="more-button" aria-label={`Actions for ${supplier.name}`} onClick={() => { setSupplierNotice(''); setActionRow({ supplier, owed, count: theirs.length }) }}>•••</button></div></td>
        </tr>)}
      </tbody></table></div></div>
      {actionRow && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setActionRow(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SUPPLIER ACTIONS</div><h2>{actionRow.supplier.name}</h2><p>{actionRow.supplier.phone || 'No phone'} · {actionRow.count} purchase{actionRow.count === 1 ? '' : 's'}{actionRow.owed > 0 ? ` · shop owes ${money.format(actionRow.owed)}` : ''}</p></div><button className="close-button" onClick={() => setActionRow(null)} aria-label={tx('Close')}><X size={19} /></button></div><div className="modal-body"><div className="action-row"><button className="secondary-button" onClick={() => startEditSupplier(actionRow.supplier)}>{tx('Edit')}</button>{isListed(actionRow.supplier) && <button className="secondary-button danger" onClick={() => deleteSupplier(actionRow)}>{tx('Delete')}</button>}</div>{!isListed(actionRow.supplier) && <p className="form-message" style={{ color: 'var(--muted)' }}>This supplier was only typed on purchases. Edit saves them as a supplier with contact details.</p>}{supplierNotice && <p className="form-message warn-note" role="alert">{supplierNotice}</p>}</div></div></div>}
      {editingSupplier && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditingSupplier(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> EDIT SUPPLIER</div><h2>{editingSupplier.name}</h2><p>Changing the name also updates the purchases from this supplier.</p></div><button className="close-button" onClick={() => setEditingSupplier(null)} aria-label={tx('Close')}><X size={19} /></button></div><form onSubmit={saveSupplier}><label>{tx('Supplier or company name')}<input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></label><label>{tx('Contact person')}<input value={editForm.contact} onChange={(event) => setEditForm({ ...editForm, contact: event.target.value })} /></label><label>{tx('Phone number')}<input value={editForm.phone} onChange={(event) => setEditForm({ ...editForm, phone: event.target.value })} /></label><label>{tx('Email address')}<input type="email" value={editForm.email} onChange={(event) => setEditForm({ ...editForm, email: event.target.value })} /></label>{supplierNotice && <p className="form-message warn-note" role="alert">{supplierNotice}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditingSupplier(null)}>{tx('Cancel')}</button><button type="submit" className="primary-button">{tx('Save changes')}</button></div></form></div></div>}
      {showAdd && <AddSupplierModal form={form} setForm={setForm} onClose={() => setShowAdd(false)} onSubmit={submit} />}
      {paying && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPaying(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SUPPLIER CREDIT</div><h2>{tx('Pay supplier')}</h2><p>{paying.supplier.name} · owed {money.format(paying.owed)}</p></div><button className="close-button" onClick={() => setPaying(null)} aria-label={tx('Close')}><X size={19} /></button></div>
        <form onSubmit={confirmPayment}><div className="modal-form-grid vertical">
          <label>{tx('Amount paid')} <span className="optional">ETB · oldest purchases are paid first</span><input autoFocus required min="0.01" max={paying.owed} step="0.01" type="number" value={payAmount} onChange={(event) => setPayAmount(event.target.value)} /></label>
          <div className="form-total"><span>{tx('Still owed after this')}</span><strong>{money.format(Math.max(paying.owed - (Number(payAmount) || 0), 0))}</strong></div>
        </div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setPaying(null)}>{tx('Cancel')}</button><button type="submit" className="primary-button">{tx('Record payment')}</button></div></form>
      </div></div>}
    </section>
  )
}

function AddSupplierModal({ form, setForm, onClose, onSubmit }: { form: { name: string; contact: string; phone: string; email: string }; setForm: React.Dispatch<React.SetStateAction<typeof form>>; onClose: () => void; onSubmit: (event: React.FormEvent) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> NEW SUPPLIER</div><h2>{tx('Add supplier')}</h2><p>Create a supplier record for your supply network.</p></div><button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button></div><form onSubmit={onSubmit}><label>{tx('Supplier or company name')}<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Addis Pipe Works" /></label><label>{tx('Contact person')}<input value={form.contact} onChange={(event) => setForm({ ...form, contact: event.target.value })} placeholder="Contact name" /></label><label>{tx('Phone number')}<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="+251 ..." /></label><label>{tx('Email address')}<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="supplier@company.example" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{tx('Cancel')}</button><button type="submit" className="primary-button"><Truck size={17} /> {tx('Add supplier')}</button></div></form></div></div>
}
const EXPENSE_CATEGORIES = [
  { value: 'Rent', am: 'ኪራይ' },
  { value: 'Transport (Isuzu)', am: 'ትራንስፖርት (ኢሱዙ)' },
  { value: 'Light bill', am: 'የኤሌክትሪክ ክፍያ' },
  { value: 'Daily labor', am: 'የዕለት ሠራተኛ' },
  { value: 'Other', am: 'ሌላ' },
]
const expenseCategoryAm = (value: string) => EXPENSE_CATEGORIES.find((category) => category.value === value)?.am ?? ''
const expenseCategoryLabel = (value: string) => { const am = expenseCategoryAm(value); return am ? `${value} (${am})` : value }

function ExpensesPage({ expenses, branch, onAdd, onEdit, onDelete, t }: { expenses: Expense[]; branch: string; onAdd: () => void; onEdit: (expense: Expense) => void; onDelete: (id: string) => void; t: (k: TranslationKey) => string }) {
  const [selected, setSelected] = useState<Expense | null>(null)
  const [exportPeriod, setExportPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'>('monthly')
  const periodLabel = (key: typeof exportPeriod) => ({ daily: 'This day', weekly: 'This week', monthly: 'This month', yearly: 'This year', all: 'All time' }[key])
  const ethMonth = toEthiopianDate(new Date())
  const monthName = ethMonth.monthNameEn
  const monthExpenses = expenses.filter((expense) => inCalendarPeriod(expense.date, 'month'))
  const monthTotal = monthExpenses.reduce((sum, expense) => sum + expense.amount, 0)
  const total = expenses.reduce((sum, expense) => sum + expense.amount, 0)
  const transport = expenses.filter((e) => e.category === 'Transport (Isuzu)').reduce((s, e) => s + e.amount, 0)
  const rents = expenses.filter((e) => e.category === 'Rent').sort((a, b) => b.date.localeCompare(a.date))
  const lastRentDate = rents[0]?.date ?? null
  const [expenseSort, setExpenseSort] = useState<ListSort>('newest')
  const sorted = sortRecords(expenses, expenseSort, (e) => e.amount)
  const groups = [...new Set(sorted.map((e) => e.category))].map((category) => {
    let total = 0
    const items = sorted.filter((e) => e.category === category).map((e) => { total += e.amount; return e })
    return { category, items, total }
  })

  return (
    <section className="expenses-page">
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> EXPENSE TRACKING</div><h1>{t('heading.expenses')}</h1><p>Rent, Isuzu transport, daily labor, utilities — so the profit number tells the truth.</p></div><div className="heading-actions"><div className="report-period expense-period"><ClipboardList size={16} /><select aria-label="Expense export period" value={exportPeriod} onChange={(event) => setExportPeriod(event.target.value as typeof exportPeriod)}><option value="daily">{tx('This day')}</option><option value="weekly">{tx('This week')}</option><option value="monthly">{tx('This month')}</option><option value="yearly">{tx('This year')}</option><option value="all">{tx('All time')}</option></select><ChevronDown size={14} /></div><button className="primary-button" onClick={() => generateExpensesPDF({ period: periodLabel(exportPeriod), periodKey: exportPeriod, branch, expenses })}><ArrowDownToLine size={17} /> Export PDF</button><button className="primary-button" onClick={onAdd}><Plus size={18} /> {t('action.addExpense')}</button></div></section>

      <section className="metric-grid expense-metrics">
        <Metric icon={<Wallet size={19} />} label={tx('This month')} value={money.format(monthTotal)} detail={`${monthName} · ${monthExpenses.length} entries`} accent="orange" />
        <Metric icon={<Truck size={19} />} label="Transport (Isuzu)" value={money.format(transport)} detail={tx('All time')} accent="blue" />
        <Metric icon={<Home size={19} />} label="Rent" value={money.format(rents.reduce((s, e) => s + e.amount, 0))} detail={lastRentDate ? `Last paid ${dateLabel(lastRentDate)}` : 'Not recorded yet'} accent="green" />
        <Metric icon={<CircleDollarSign size={19} />} label={tx('Total expenses')} value={money.format(total)} detail="All records" accent="red" />
      </section>

      <div className="panel expenses-panel">
        <div className="panel-header"><div><h2>Expense history</h2><p>Every outgoing payment, grouped by category.</p></div><div className="row-actions"><SortSelect value={expenseSort} onChange={setExpenseSort} label="Sort expenses" /><span className="directory-count">{expenses.length} shown</span></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{tx('Category')}</th><th>{tx('Note')}</th><th>{tx('Date')}</th><th className="right">{tx('Amount')}</th><th /></tr></thead>
            <tbody>
              {expenses.length === 0 ? <tr><td colSpan={5}><em>No expenses yet. Click "Add expense" to record one.</em></td></tr> : groups.map((group) => (
                <Fragment key={group.category}>
                  <tr className="expense-group-head"><td colSpan={5}><b>{expenseCategoryLabel(group.category)}</b> · {group.items.length} {group.items.length === 1 ? 'entry' : 'entries'}</td></tr>
                  {group.items.map((expense) => <tr key={expense.id}><td><div className="purchase-product"><div className="mini-product">{expense.category.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><b>{expenseCategoryLabel(expense.category)}</b></div></div></td><td>{expense.note || '—'}</td><td>{formatDualDate(`${expense.date}T12:00:00`)}</td><td className="right expense-out">−{money.format(expense.amount)}</td><td><button className="more-button" aria-label={`View ${expense.category}`} onClick={() => setSelected(expense)}>{tx('Details')}</button></td></tr>)}
                  <tr className="expense-group-total"><td colSpan={4} className="right">{expenseCategoryLabel(group.category)} subtotal</td><td className="right expense-out">−{money.format(group.total)}</td></tr>
                </Fragment>
              ))}
              {expenses.length > 0 && <tr className="expense-grand-total"><td colSpan={4} className="right"><b>{tx('Total expenses')}</b></td><td className="right"><b>{money.format(total)}</b></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> EXPENSE ACTIONS</div><h2>{expenseCategoryLabel(selected.category)}</h2><p>{selected.note || 'No note'} · {money.format(selected.amount)}</p></div><button className="close-button" onClick={() => setSelected(null)} aria-label={tx('Close')}><X size={19} /></button></div><div className="modal-body"><div className="action-row"><button className="secondary-button" onClick={() => { onEdit(selected); setSelected(null) }}>{tx('Edit')}</button><button className="secondary-button danger" onClick={() => { onDelete(selected.id); setSelected(null) }}>{tx('Delete')}</button></div></div></div></div>}
    </section>
  )
}

function AddExpenseModal({ form, setForm, editing, onClose, onSubmit }: { form: { category: string; note: string; amount: string }; setForm: React.Dispatch<React.SetStateAction<typeof form>>; editing: Expense | null; onClose: () => void; onSubmit: (event: React.FormEvent) => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> {editing ? 'EDIT EXPENSE' : 'NEW EXPENSE'}</div><h2>{editing ? 'Edit expense' : 'Add expense'}</h2><p>Record money going out of the business.</p></div><button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button></div><form onSubmit={onSubmit}><label>{tx('Category')}<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option value="" disabled>Select a category</option>{EXPENSE_CATEGORIES.map((category) => <option key={category.value} value={category.value}>{category.value} ({category.am})</option>)}</select></label><label>{tx('Amount (ETB)')}<input type="number" min="0.01" step="0.01" required value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="e.g. 15000" /></label><label>{tx('Note')}<input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Optional description" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{tx('Cancel')}</button><button type="submit" className="primary-button"><Wallet size={17} /> {editing ? 'Save changes' : 'Add expense'}</button></div></form></div></div>
}

function AddCustomerModal({ customer, setCustomer, onClose, onSubmit }: { customer: { name: string; phone: string; email: string }; setCustomer: React.Dispatch<React.SetStateAction<typeof customer>>; onClose: () => void; onSubmit: (event: React.FormEvent) => void }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> NEW ACCOUNT</div><h2>{tx('Add customer')}</h2><p>Create a customer record for sales and credit tracking.</p></div><button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button></div><form onSubmit={onSubmit}><label>{tx('Customer or company name')}<input required value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} placeholder="e.g. Riverbend Contractors" /></label><label>{tx('Phone number')}<input value={customer.phone} onChange={(event) => setCustomer({ ...customer, phone: event.target.value })} placeholder="+1 555 010 0000" /></label><label>{tx('Email address')}<input type="email" value={customer.email} onChange={(event) => setCustomer({ ...customer, email: event.target.value })} placeholder="accounts@company.example" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{tx('Cancel')}</button><button type="submit" className="primary-button"><Users size={17} /> {tx('Add customer')}</button></div></form></div></div> }

function CreditPaymentModal({ customerName, credit, partialAmount, setPartialAmount, onClose, onConfirm }: { customerName: string; credit: number; partialAmount: string; setPartialAmount: (v: string) => void; onClose: () => void; onConfirm: () => void }) {
  const [mode, setMode] = useState<'full' | 'partial'>('full')
  const amt = Number(partialAmount)
  const isValidPartial = mode === 'full' || (partialAmount !== '' && Number.isFinite(amt) && amt > 0 && amt <= credit)

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal">
      <div className="modal-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> CREDIT PAYMENT</div>
          <h2>Pay credit for {customerName}</h2>
          <p>Outstanding balance: <strong style={{ color: '#dc2626' }}>{money.format(credit)}</strong></p>
        </div>
        <button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button>
      </div>
      <div className="credit-payment-options">
        <button className={`credit-option-btn ${mode === 'full' ? 'active' : ''}`} onClick={() => setMode('full')}>
          <CircleDollarSign size={20} />
          <div><b>Full Pay</b><small>Clear the entire {money.format(credit)} balance</small></div>
        </button>
        <button className={`credit-option-btn ${mode === 'partial' ? 'active' : ''}`} onClick={() => setMode('partial')}>
          <CircleDollarSign size={20} />
          <div><b>Add Amount</b><small>Pay a partial amount toward the balance</small></div>
        </button>
      </div>
      {mode === 'partial' && <div className="credit-partial-input">
        <label>Payment amount (ETB)<input type="number" min="0.01" step="0.01" max={credit} value={partialAmount} onChange={(event) => setPartialAmount(event.target.value)} placeholder="Enter amount" /></label>
        {partialAmount !== '' && <p className={isValidPartial ? 'partial-valid' : 'partial-error'}>{isValidPartial ? `Remaining balance: ${money.format(credit - amt)}` : 'Enter a valid amount'}</p>}
      </div>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose}>{tx('Cancel')}</button>
        <button type="button" className="primary-button" disabled={!isValidPartial} onClick={onConfirm}>{mode === 'full' ? 'Pay Full Balance' : `Pay ${partialAmount !== '' && isValidPartial ? money.format(amt) : 'Amount'}`}</button>
      </div>
    </div>
  </div>
}
function ReportsPage({ products, purchases, sales, branch, t, suppliers, fifo }: { fifo: FifoResult | null; suppliers: Supplier[]; products: Product[]; purchases: Purchase[]; sales: Sale[]; branch?: string; t: (k: TranslationKey) => string }) {
  const [period, setPeriod] = useState('This day')
  const [reportDate, setReportDate] = useState<string | null>(null)
  const now = new Date()
  const dateKey = (value?: string) => (value || '').slice(0, 10)
  const todayISO = localDate(now)
  // Same periods as every other screen: Monday weeks, Ethiopian month/year.
  const periodKey: PeriodKey = period === 'This day' ? 'day' : period === 'This week' ? 'week' : period === 'This month' ? 'month' : period === 'This year' ? 'year' : 'all'
  const inPeriod = (value?: string) => inCalendarPeriod(dateKey(value), periodKey, now)
  const scopeSales = reportDate ? sales.filter((sale) => sale.date === reportDate) : sales.filter((sale) => inPeriod(sale.date))
  const scopePurchases = reportDate ? purchases.filter((purchase) => purchase.date === reportDate) : purchases.filter((purchase) => inPeriod(purchase.date))
  const salesTotal = scopeSales.reduce((sum, sale) => sum + sale.total, 0)
  const paidTotal = scopeSales.reduce((sum, sale) => sum + sale.paid, 0)
  const purchasesTotal = scopePurchases.reduce((sum, purchase) => sum + purchaseTotalCost(purchase), 0)
  // FIFO: each sale's cost is the price of the batches it used up, so it
  // never changes when an item is edited.
  const costOfSale = (sale: Sale) => fifo?.saleCost.get(sale.id)?.cost ?? sale.quantity * (findSaleProduct(products, sale)?.costPrice ?? 0)
  const estimatedCost = scopeSales.reduce((sum, sale) => sum + costOfSale(sale), 0)
  const grossProfit = salesTotal - estimatedCost
  const [selectedReceipt, setSelectedReceipt] = useState<Sale | null>(null)
  const reportGeneratedAt = useMemo(() => new Date(), [])
  const todayDate = localDate()
  const todayReceipts = scopeSales.filter((sale) => sale.date === todayDate)
  const todayRevenue = todayReceipts.reduce((sum, sale) => sum + sale.paid, 0)
  const latestReceipts = [...scopeSales]
    .sort(newestFirst)
    .slice(0, 4)
  const reportRows = [
    { label: 'Sales revenue', value: salesTotal, detail: `${scopeSales.length} transactions`, accent: 'orange' },
    { label: 'Payments received', value: paidTotal, detail: `${scopeSales.filter((sale) => sale.paid >= sale.total).length} fully paid`, accent: 'green' },
    { label: 'Purchase spend', value: purchasesTotal, detail: `${scopePurchases.length} purchase orders`, accent: 'blue' },
    { label: 'Gross profit', value: grossProfit, detail: fifo ? 'Sales minus the cost of the stock sold (FIFO)' : 'Estimated from product cost', accent: 'olive' },
  ]
  const formatDateTime = (date: string, time: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(`${date}T${time}`))
  const reportUpdatedAt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(reportGeneratedAt)

  function handleExportPDF() {
    generatePDFReport({
      title: `Financial & Operations Summary (${reportDate ?? period})`,
      period: reportDate ?? period,
      branch: branch || 'Mame Main Branch',
      sales: scopeSales,
      purchases: scopePurchases,
      products,
      costOfSale,
      // Debt is a balance, not a period figure: always as of today.
      supplierDebts: supplierBalances(suppliers, purchases).map((row) => ({ name: row.supplier.name, phone: row.supplier.phone, owed: row.owed, nextDue: row.nextDue, openPurchases: row.purchases.filter((purchase) => purchaseOwed(purchase) > 0).length })),
    })
  }

  // Prepare trend data from sales & purchases grouped by date
  // (Chart data lives in GraphViewPage; this page renders tables only.)

  return <section className="reports-page"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> BUSINESS INTELLIGENCE</div><h1>{t('heading.reports')}</h1><p>{t('heading.reportsDesc')}</p></div><div className="heading-actions"><button className="primary-button" onClick={handleExportPDF}><ArrowDownToLine size={18} /> {tx('Export PDF Report')}</button><EthiopianDatePicker label={tx('Filter by date')} value={reportDate ?? localDate()} onChange={setReportDate} />{reportDate && <button className="secondary-button" onClick={() => setReportDate(null)}>All dates</button>}<div className="report-period"><ClipboardList size={16} /><select aria-label="Report period" value={period} onChange={(event) => setPeriod(event.target.value)}><option>{tx('This day')}</option><option>{tx('This week')}</option><option>{tx('This month')}</option><option>{tx('This year')}</option><option>{tx('All time')}</option></select><ChevronDown size={14} /></div></div></section><div className="report-banner"><div><span className="eyebrow">REPORTING PERIOD</span><strong>{period}</strong><small>Totals and transactions for the period you choose</small></div><div className="report-banner-date">Updated {reportUpdatedAt} <ArrowUpRight size={15} /></div></div><section className="report-metrics">{reportRows.map((row) => <div className="report-metric" key={row.label}><div className={`report-metric-mark ${row.accent}`} /><span>{row.label}</span><strong>{money.format(row.value)}</strong><small>{row.detail}</small></div>)}</section>

  <div className="reports-grid"><div className="panel report-table-panel"><div className="panel-header"><div><h2>{tx('Transaction summary')}</h2><p>Receipts and movement for {period.toLowerCase()}.</p></div></div><div className="report-summary-list"><div><span>{tx('Cash and card receipts')}</span><strong>{money.format(paidTotal)}</strong></div><div><span>{tx('Customer credit created')}</span><strong className="report-credit">{money.format(Math.max(salesTotal - paidTotal, 0))}</strong></div><div><span>{tx('Inventory purchased')}</span><strong>{money.format(purchasesTotal)}</strong></div><div><span>{tx('Estimated gross margin')}</span><strong className="report-profit">{salesTotal ? `${Math.round((grossProfit / salesTotal) * 100)}%` : '0%'}</strong></div></div></div><div className="panel report-table-panel"><div className="panel-header"><div><h2>{tx('Latest receipts')}</h2><p>Recent paid and credit sales.</p></div></div><div className="receipt-list">{latestReceipts.map((receipt) => <div className="receipt-row" key={receipt.id}><div className="receipt-icon"><CircleDollarSign size={15} /></div><div className="receipt-copy"><span>{receipt.productName}</span><small>{receipt.customer}</small></div><div className="receipt-meta"><strong>{money.format(receipt.paid)}</strong><small>{formatDateTime(receipt.date, shownTime(receipt))}</small></div><button className="detail-button" onClick={() => setSelectedReceipt(receipt)}>Detail</button></div>)}</div></div></div>{selectedReceipt && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedReceipt(null)}><div className="modal receipt-detail-modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> RECEIPT DETAILS</div><h2>{selectedReceipt.productName}</h2><p>Sale receipt for {selectedReceipt.customer}</p></div><button className="close-button" onClick={() => setSelectedReceipt(null)} aria-label={tx('Close')}><X size={19} /></button></div><div className="receipt-detail-body"><div className="receipt-detail-row"><span>Buyer</span><strong>{selectedReceipt.customer}</strong></div><div className="receipt-detail-row"><span>{tx('Phone')}</span><strong>{selectedReceipt.customerPhone || '—'}</strong></div><div className="receipt-detail-row"><span>Purchase time</span><strong>{formatDateTime(selectedReceipt.date, shownTime(selectedReceipt))}</strong></div><div className="receipt-detail-row"><span>{tx('Product')}</span><strong>{selectedReceipt.productName}</strong></div><div className="receipt-detail-row"><span>{tx('Quantity')}</span><strong>{selectedReceipt.quantity}</strong></div>{selectedReceipt.unitPrice != null && <div className="receipt-detail-row"><span>{tx('Unit price')}</span><strong>{money.format(selectedReceipt.unitPrice)}</strong></div>}<div className="receipt-detail-row"><span>{tx('Total')}</span><strong>{money.format(selectedReceipt.total)}</strong></div><div className="receipt-detail-row"><span>{tx('Paid')}</span><strong>{money.format(selectedReceipt.paid)}</strong></div><div className="receipt-detail-row"><span>Remaining</span><strong>{money.format(Math.max(selectedReceipt.total - selectedReceipt.paid, 0))}</strong></div>{selectedReceipt.dueDate && <div className="receipt-detail-row"><span>Due date</span><strong>{formatDualDate(selectedReceipt.dueDate)}</strong></div>}<div className="receipt-status-badge">{Math.max(selectedReceipt.total - selectedReceipt.paid, 0) === 0 ? <span className="badge badge-paid">✓ Paid</span> : <span className="badge badge-credit">Credit</span>}</div></div></div></div>}</section>
}

function GraphViewPage({ products, purchases, sales, t }: { products: Product[]; purchases: Purchase[]; sales: Sale[]; t: (k: TranslationKey) => string }) {
  const [period, setPeriod] = useState('This day')
  const now = new Date()
  const dateKey = (value?: string) => (value || '').slice(0, 10)
  const todayISO = localDate(now)
  // Same periods as every other screen: Monday weeks, Ethiopian month/year.
  const periodKey: PeriodKey = period === 'This day' ? 'day' : period === 'This week' ? 'week' : period === 'This month' ? 'month' : period === 'This year' ? 'year' : 'all'
  const inPeriod = (value?: string) => inCalendarPeriod(dateKey(value), periodKey, now)
  const scopeSales = sales.filter((sale) => inPeriod(sale.date))
  const scopePurchases = purchases.filter((purchase) => inPeriod(purchase.date))

  const chartData = useMemo(() => {
    const datesMap: Record<string, { date: string; sales: number; purchases: number; salesCount: number; purchaseCount: number }> = {}
    scopeSales.forEach((s) => {
      const d = s.date || 'Unknown'
      if (!datesMap[d]) datesMap[d] = { date: d, sales: 0, purchases: 0, salesCount: 0, purchaseCount: 0 }
      datesMap[d].sales += s.total || 0
      datesMap[d].salesCount += 1
    })
    scopePurchases.forEach((p) => {
      const d = p.date || 'Unknown'
      if (!datesMap[d]) datesMap[d] = { date: d, sales: 0, purchases: 0, salesCount: 0, purchaseCount: 0 }
      datesMap[d].purchases += purchaseTotalCost(p)
      datesMap[d].purchaseCount += 1
    })
    return Object.values(datesMap).sort((a, b) => a.date.localeCompare(b.date))
  }, [scopeSales, scopePurchases])

  const categoryData = useMemo(() => {
    const catMap: Record<string, number> = {}
    scopeSales.forEach((s) => {
      const product = findSaleProduct(products, s)
      const cat = product?.category || 'General'
      catMap[cat] = (catMap[cat] || 0) + s.total
    })
    return Object.entries(catMap).map(([name, value]) => ({ name, value }))
  }, [scopeSales, products])

  const PIE_COLORS = ['#ea580c', '#0d9488', '#7c3aed', '#db2777', '#16a34a']
  const salesTotal = scopeSales.reduce((sum, sale) => sum + sale.total, 0)
  const purchasesTotal = scopePurchases.reduce((sum, purchase) => sum + purchaseTotalCost(purchase), 0)

  return <section className="reports-page"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> VISUAL ANALYTICS</div><h1>{t('heading.graph')}</h1><p>{t('heading.graphDesc')}</p></div><div className="heading-actions"><div className="report-period"><ClipboardList size={16} /><select aria-label="Graph period" value={period} onChange={(event) => setPeriod(event.target.value)}><option>{tx('This day')}</option><option>{tx('This week')}</option><option>{tx('This month')}</option><option>{tx('This year')}</option><option>{tx('All time')}</option></select><ChevronDown size={14} /></div></div></section><section className="report-metrics"><div className="report-metric"><div className="report-metric-mark blue" /><span>{tx('Sales revenue')}</span><strong>{money.format(salesTotal)}</strong><small>{scopeSales.length} transactions</small></div><div className="report-metric"><div className="report-metric-mark orange" /><span>{tx('Purchase spend')}</span><strong>{money.format(purchasesTotal)}</strong><small>{scopePurchases.length} purchase orders</small></div><div className="report-metric"><div className="report-metric-mark green" /><span>Categories sold</span><strong>{categoryData.length}</strong><small>Product categories</small></div><div className="report-metric"><div className="report-metric-mark olive" /><span>Period</span><strong>{period}</strong><small>Chart range</small></div></section>

  {/* Revenue vs Purchase Spend Trend */}
  <div className="overview-grid" style={{ marginBottom: '24px' }}>
    <div className="panel" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '1.05rem', margin: 0, fontWeight: 700, color: 'var(--ink)' }}>Revenue vs. Purchase Spend Trend</h2>
          <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '4px 0 0' }}>Interactive timeline comparison across transactions</p>
        </div>
        <div style={{ display: 'flex', gap: '12px', fontSize: '0.78rem', fontWeight: 600 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--ink)' }}><span style={{ color: '#ea580c' }}>●</span>Sales</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--ink)' }}><span style={{ color: '#0d9488' }}>●</span>Purchases</span>
        </div>
      </div>
      <div style={{ width: '100%', height: '240px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ea580c" stopOpacity={0.4}/>
                <stop offset="95%" stopColor="#ea580c" stopOpacity={0.0}/>
              </linearGradient>
              <linearGradient id="purGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0d9488" stopOpacity={0.4}/>
                <stop offset="95%" stopColor="#0d9488" stopOpacity={0.0}/>
              </linearGradient>
            </defs>
            <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} />
            <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} />
            <Tooltip contentStyle={{ background: 'var(--bg-panel, #ffffff)', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '12px' }} />
            <Area type="monotone" dataKey="sales" name="Sales (ETB)" stroke="#ea580c" strokeWidth={2.5} fillOpacity={1} fill="url(#salesGrad)" />
            <Area type="monotone" dataKey="purchases" name="Purchases (ETB)" stroke="#0d9488" strokeWidth={2.5} fillOpacity={1} fill="url(#purGrad)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>

    {/* Category Share */}
    <div className="panel" style={{ padding: '20px' }}>
      <h2 style={{ fontSize: '1.05rem', margin: 0, fontWeight: 700, color: 'var(--ink)' }}>Category Share</h2>
      <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '4px 0 12px' }}>Sales distribution by product category</p>
      {categoryData.length === 0 ? <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.85rem', padding: '50px 0' }}>No sales data for this period.</div> : <><div style={{ width: '100%', height: '200px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={categoryData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} innerRadius={40} paddingAngle={4}>
              {categoryData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ background: 'var(--bg-panel, #ffffff)', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '12px' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginTop: '4px' }}>
        {categoryData.map((item, idx) => (
          <span key={item.name} style={{ fontSize: '0.75rem', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: PIE_COLORS[idx % PIE_COLORS.length] }} />
            {item.name}
          </span>
        ))}
      </div></>}
    </div>
  </div>

  {/* Transaction volume */}
  <div className="panel" style={{ padding: '20px', marginBottom: '24px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
      <div>
        <h2 style={{ fontSize: '1.05rem', margin: 0, fontWeight: 700, color: 'var(--ink)' }}>Transaction Volume</h2>
        <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '4px 0 0' }}>Number of sales vs purchases per day</p>
      </div>
      <div style={{ display: 'flex', gap: '12px', fontSize: '0.78rem', fontWeight: 600 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--ink)' }}><span style={{ color: '#ea580c' }}>■</span>Sales</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--ink)' }}><span style={{ color: '#0d9488' }}>■</span>Purchases</span>
      </div>
    </div>
    {chartData.length === 0 ? <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.85rem', padding: '50px 0' }}>No transactions for this period.</div> : <div style={{ width: '100%', height: '220px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} />
          <YAxis allowDecimals={false} stroke="#94a3b8" fontSize={11} tickLine={false} />
          <Tooltip contentStyle={{ background: 'var(--bg-panel, #ffffff)', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '12px' }} />
          <Bar dataKey="salesCount" name="Sales" fill="#ea580c" radius={[3, 3, 0, 0]} />
          <Bar dataKey="purchaseCount" name="Purchases" fill="#0d9488" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>}
  </div>
  </section>
}

function InventoryPage({ products, setProducts, onBack, t, fifo }: { fifo: FifoResult | null; products: Product[]; setProducts: React.Dispatch<React.SetStateAction<Product[]>>; onBack: () => void; t: (k: TranslationKey) => string }) {
  const [showAddItem, setShowAddItem] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [item, setItem] = useState({ name: '', sku: '', brand: '', category: 'Pipes', unit: 'pcs', packQty: '', stock: '0', threshold: '10', costPrice: '0', sellPrice: '' })
  const [itemSort, setItemSort] = useState<'name' | 'low' | 'value' | 'category'>('name')
  const [detailProduct, setDetailProduct] = useState<Product | null>(null)
  // Stock value: FIFO batches still in stock, or quantity x cost without FIFO.
  const valueOfItem = (product: Product) => fifo ? stockValueOf(fifo.batches.get(product.id)) : product.stock * product.costPrice
  // "Low stock first": items at or below their alert level, emptiest first.
  const lowness = (product: Product) => product.threshold > 0 ? product.stock / product.threshold : product.stock
  const visibleProducts = products
    .filter((product) => `${product.name} ${product.sku ?? ''} ${product.brand} ${product.category}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => itemSort === 'low' ? lowness(a) - lowness(b) || byName(a.name, b.name)
      : itemSort === 'value' ? valueOfItem(b) - valueOfItem(a) || byName(a.name, b.name)
      : itemSort === 'category' ? byName(a.category, b.category) || byName(a.name, b.name)
      : byName(a.name, b.name))
  const PAGE_SIZE = 10
  const totalPages = Math.max(1, Math.ceil(visibleProducts.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageProducts = visibleProducts.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  function openNewItem() {
    setEditingProduct(null)
    setItem({ name: '', sku: '', brand: '', category: 'Pipes', unit: 'pcs', packQty: '', stock: '0', threshold: '10', costPrice: '0', sellPrice: '' })
    setShowAddItem(true)
  }

  function editItem(product: Product) {
    setEditingProduct(product)
    setItem({ name: product.name, sku: product.sku ?? '', brand: product.brand, category: product.category, unit: product.unit || 'pcs', packQty: product.packQty ? product.packQty.toString() : '', stock: product.packQty ? (product.stock / product.packQty).toString() : product.stock.toString(), threshold: product.threshold.toString(), costPrice: product.costPrice.toString(), sellPrice: product.sellPriceSet && product.sellPrice ? product.sellPrice.toString() : '' })
    setShowAddItem(true)
  }

  function deleteItem(productId: string) {
    const product = products.find((item) => item.id === productId)
    if (product && !window.confirm(`Delete the item "${product.name}"?\n\nIts past sales and purchases stay in the records and reports.${product.stock > 0 ? ` It still has ${packBreakdown(product.stock, product)} in stock.` : ''}`)) return
    setProducts((current) => current.filter((product) => product.id !== productId))
  }

  function saveItem(event: React.FormEvent) {
    event.preventDefault()
    const packQty = Number(item.packQty) > 0 ? Number(item.packQty) : 1
    const enteredStock = Number(item.stock)
    // The form shows stock in packs using the OLD pack size. If only the pack
    // size (or unit) was corrected, the stock itself did not change: keep it.
    // (Before, 100 pcs shown as "10" boxes of 10 became 50 pcs when the box
    // size was corrected to 5.)
    const shownBefore = editingProduct ? (editingProduct.packQty ? (editingProduct.stock / editingProduct.packQty).toString() : editingProduct.stock.toString()) : null
    const stock = editingProduct && item.stock === shownBefore ? editingProduct.stock : enteredStock * packQty
    const threshold = Number(item.threshold)
    const costPrice = Number(item.costPrice)
    // The selling price is what the shop charges. It used to be invented as
    // cost + 35% (and reset to that on every edit), and the sale form
    // pre-filled it. Now the owner sets it; blank means "type it at the till".
    const sellPrice = item.sellPrice.trim() === '' ? 0 : Number(item.sellPrice)
    if (!Number.isFinite(sellPrice) || sellPrice < 0) return
    if (!item.name.trim() || !Number.isFinite(stock) || stock < 0 || !Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(costPrice) || costPrice < 0) return

    const productData = { name: item.name.trim(), sku: (item.sku || '').trim().toUpperCase(), brand: item.brand.trim() || 'Unbranded', category: item.category, unit: (item.unit || 'pcs').trim() || 'pcs', packQty: Number(item.packQty) > 0 ? Number(item.packQty) : undefined, stock, threshold, costPrice, sellPrice, sellPriceSet: sellPrice > 0 }

    if (editingProduct) {
      setProducts((current) => current.map((product) => product.id === editingProduct.id ? { ...product, ...productData } : product))
    } else {
      setProducts((current) => [...current, { id: `p-${Date.now()}`, ...productData }])
    }

    setItem({ name: '', sku: '', brand: '', category: 'Pipes', unit: 'pcs', packQty: '', stock: '0', threshold: '10', costPrice: '0', sellPrice: '' })
    setEditingProduct(null)
    setShowAddItem(false)
  }

  return <section className="inventory-page"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> STOCK CONTROL</div><h1>{t('heading.items')}</h1><p>{t('heading.itemsDesc')}</p></div><div className="heading-actions">{ITEMS_STOCK_PDF && <button className="secondary-button" onClick={() => generateStockPDF({ products, batchesOf: fifo ? (product) => fifo.batches.get(product.id) ?? [] : undefined })} disabled={products.length === 0} title="Stock list with quantity and stock value">{tx('Stock list PDF')}</button>}<button className="secondary-button" onClick={onBack}>{t('action.backToPurchases')}</button><button className="primary-button" onClick={openNewItem}><Plus size={18} /> {editingProduct ? 'Edit item' : t('action.addItem')}</button></div></section><div className="inventory-toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search inventory" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="Search items, SKU, brand..." /></div><SortMenu value={itemSort} onChange={(value) => { setItemSort(value); setPage(1) }} label="Sort items" options={[['name', 'Name A–Z'], ['low', 'Low stock first'], ['value', 'Highest stock value'], ['category', 'Category']]} /><span>{products.length} products</span></div><div className="panel inventory-panel"><table><thead><tr><th>{tx('Item')}</th><th>{tx('Brand')}</th><th>{tx('Category')}</th><th>{tx('Stock')}</th><th>{FIFO_COSTING ? tx('Selling price') : tx('Cost price')}</th><th /></tr></thead><tbody>{pageProducts.map((product) => <tr key={product.id}><td><div className="purchase-product"><div className="mini-product">{product.name.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><b>{product.name}</b><small>{product.sku}</small></div></div></td><td>{product.brand}</td><td>{product.category}</td><td><span className="quantity-pill">{stockLabel(product)}</span></td><td>{FIFO_COSTING ? (product.sellPriceSet && product.sellPrice > 0 ? <><b>{money.format(product.sellPrice)}</b><small className="per-unit"> / {isRollUnit(product.unit) ? 'm' : /kilo|kg/i.test(product.unit || '') ? 'kg' : 'pc'}</small></> : <small className="per-unit">{tx('Not set')}</small>) : <><b>{money.format(product.costPrice)}</b><small className="per-unit"> / {isRollUnit(product.unit) ? 'm' : /kilo|kg/i.test(product.unit || '') ? 'kg' : 'pc'}</small>{product.sellPriceSet && product.sellPrice > 0 && <small className="sell-line">{tx('Sells at')} {money.format(product.sellPrice)}</small>}</>}</td><td><div className="row-actions">{FIFO_COSTING && <button className="secondary-button" onClick={() => setDetailProduct(product)}>{tx('Detail')}</button>}<button className="secondary-button" onClick={() => editItem(product)}>{tx('Edit')}</button><button className="secondary-button danger" onClick={() => deleteItem(product.id)}>{tx('Delete')}</button></div></td></tr>)}</tbody></table>{visibleProducts.length === 0 && <div className="empty-state">No inventory items match your search.</div>}{totalPages > 1 && <div className="pagination"><button className="secondary-button" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button><span className="pagination-label">Page {safePage} of {totalPages}</span><button className="secondary-button" disabled={safePage === totalPages} onClick={() => setPage(safePage + 1)}>Next</button></div>}</div>{detailProduct && <ItemDetailModal product={products.find((p) => p.id === detailProduct.id) ?? detailProduct} batches={fifo?.batches.get(detailProduct.id) ?? []} onClose={() => setDetailProduct(null)} />}{showAddItem && <AddItemModal item={item} setItem={setItem} onClose={() => { setShowAddItem(false); setEditingProduct(null) }} onSubmit={saveItem} submitLabel={editingProduct ? 'Save changes' : 'Add item'} modalTitle={editingProduct ? 'Edit inventory item' : 'Add inventory item'} />}</section>
}

function SalesPage({ products, sales, setProducts, setSales, customers, setCustomers, t }: { products: Product[]; sales: Sale[]; setProducts: React.Dispatch<React.SetStateAction<Product[]>>; setSales: React.Dispatch<React.SetStateAction<Sale[]>>; customers: Customer[]; setCustomers: React.Dispatch<React.SetStateAction<Customer[]>>; t: (k: TranslationKey) => string }) {
  const [showSale, setShowSale] = useState(false)
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null)
  const [editingSale, setEditingSale] = useState<Sale | null>(null)
  const [selectedIsoDate, setSelectedIsoDate] = useState(() => localDate())
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('daily')
  const [saleSort, setSaleSort] = useState<ListSort>('newest')
  const [saleNotice, setSaleNotice] = useState('')
  const [saleQuery, setSaleQuery] = useState('')
  const [sale, setSale] = useState({ productId: products[0]?.id ?? '', customer: '', phone: '', quantity: '1', unitPrice: products[0]?.sellPriceSet && products[0].sellPrice ? products[0].sellPrice.toString() : '', paid: '0', paymentType: 'credit', dueDate: '', sellBy: 'pack' })
  const selectedProduct = products.find((product) => product.id === sale.productId) ?? products[0]
  const packQty = selectedProduct?.packQty || 1
  const quantity = Number(sale.quantity) || 0
  // A carton product can be sold by the whole carton or by the single piece.
  const sellingBase = sale.sellBy === 'base' || packQty <= 1
  const totalQty = sellingBase ? quantity : quantity * packQty
  const total = Math.round(totalQty * (Number(sale.unitPrice) || 0) * 100) / 100
  // When editing, the sale's own quantity is still on the shelf as far as
  // this edit is concerned. Without this, a sale that took the last stock
  // could never be edited: the form rejected it silently.
  const editedProductId = editingSale ? findSaleProduct(products, editingSale)?.id : undefined
  const available = (selectedProduct?.stock ?? 0) + (editingSale && editedProductId === selectedProduct?.id ? editingSale.quantity : 0)
  const paid = Number(sale.paid) || 0
  const owed = Math.max(total - paid, 0)
  const overpayment = Math.max(paid - total, 0)

  const selectedEthDate = toEthiopianDate(new Date(`${selectedIsoDate}T12:00:00`))
  const isoWeekOf = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`)
    const day = (d.getDay() + 6) % 7
    d.setDate(d.getDate() - day + 3)
    const firstThursday = new Date(d.getFullYear(), 0, 4)
    const week: number = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7)
    return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
  }
  const currentIsoWeek = isoWeekOf(selectedIsoDate)
  const ethOf = (isoDate: string) => toEthiopianDate(new Date(`${isoDate}T12:00:00`))
  const filteredSales = period === 'daily' ? sales.filter((item) => item.date === selectedIsoDate)
    : period === 'weekly' ? sales.filter((item) => isoWeekOf(item.date) === currentIsoWeek)
    // Month and Year follow the Ethiopian calendar, matching the labels
    // ("መስከረም 2019", "2019 E.C."). They used to filter by the Gregorian
    // month/year, so "መስከረም" actually showed September 1-30.
    : period === 'monthly' ? sales.filter((item) => { const eth = ethOf(item.date); return eth.year === selectedEthDate.year && eth.month === selectedEthDate.month })
    : sales.filter((item) => ethOf(item.date).year === selectedEthDate.year)
  const saleNeedle = saleQuery.trim().toLowerCase()
  const shownSales = sortRecords(saleNeedle ? filteredSales.filter((item) => `${item.id} ${item.customer} ${item.productName} ${item.customerPhone ?? ''}`.toLowerCase().includes(saleNeedle)) : filteredSales, saleSort, (item) => item.total)
  const dayTotal = filteredSales.reduce((sum, item) => sum + item.total, 0)
  const periodLabel = period === 'daily' ? `${selectedEthDate.monthNameAm} ${selectedEthDate.day}`
    : period === 'weekly' ? `Week of ${selectedEthDate.monthNameAm} ${selectedEthDate.day}`
    : period === 'monthly' ? `${selectedEthDate.monthNameAm} ${selectedEthDate.year}`
    : `${selectedEthDate.year} E.C.`
  const periodDetail = period === 'daily' ? 'transactions on this Ethiopian date'
    : period === 'weekly' ? 'transactions this week'
    : period === 'monthly' ? 'transactions this month'
    : 'transactions this year'
  const creditTotal = sales.reduce((sum, item) => sum + Math.max(item.total - item.paid, 0), 0)

  function selectProduct(productId: string) {
    const product = products.find((item) => item.id === productId)
    setSale((current) => ({ ...current, productId, unitPrice: product?.sellPriceSet && product.sellPrice ? product.sellPrice.toString() : '' }))
  }

  function startEditSale(item: Sale) {
    // By id, not by name: after a product was renamed the old lookup fell
    // back to the first product in the list and would have moved the sale.
    const product = findSaleProduct(products, item)
    const per = product?.packQty || 1
    const wholePacks = per > 1 && item.quantity % per === 0
    setEditingSale(item)
    setSale({
      productId: product?.id ?? products[0]?.id ?? '',
      customer: item.customer,
      phone: item.customerPhone ?? '',
      quantity: (wholePacks ? item.quantity / per : item.quantity).toString(),
      sellBy: per > 1 && !wholePacks ? 'base' : 'pack',
      unitPrice: item.quantity > 0 ? (item.total / item.quantity).toFixed(2) : '0',
      paid: item.paid.toString(),
      paymentType: item.paid >= item.total ? 'paid' : 'credit',
      dueDate: item.dueDate ?? '',
    })
    setSelectedSale(null)
    setShowSale(true)
  }

  function deleteSale(saleId: string) {
    const item = sales.find((s) => s.id === saleId)
    if (!item) return
    if (!window.confirm(`Delete sale ${item.id} (${item.customer}, ${money.format(item.total)})?\n\nThe items go back into stock.`)) return
    setSales((current) => current.filter((s) => s.id !== saleId))
    const soldProduct = findSaleProduct(products, item)
    if (soldProduct) {
      setProducts((current) => current.map((product) => product.id === soldProduct.id ? { ...product, stock: product.stock + item.quantity } : product))
    } else {
      console.warn('[sales] deleted sale', item.id, 'refers to a product that no longer exists; stock not adjusted')
    }
    setSelectedSale(null)
  }

  function recordSale(event: React.FormEvent) {
    event.preventDefault()
    // Say why nothing happened, instead of silently ignoring the click.
    const problem = !selectedProduct ? 'Add an item on the Items page first, then record a sale.'
      : !(quantity > 0) ? 'Enter a quantity above zero.'
      : String(sale.unitPrice).trim() === '' ? 'Enter the selling price.'
      : totalQty > available ? `Not enough stock: only ${packBreakdown(available, selectedProduct)} of ${selectedProduct.name} left.`
      : Number(sale.unitPrice) < 0 || paid < 0 ? 'The price and the amount paid cannot be negative.'
      : ''
    setSaleNotice(problem)
    if (problem || !selectedProduct) return
    if (editingSale) {
      const oldSale = editingSale
      const oldProduct = findSaleProduct(products, oldSale)
      setSales((current) => current.map((item) => item.id === oldSale.id ? {
        ...item,
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        customer: customers.find((c) => sameName(c.name, sale.customer))?.name ?? (sale.customer.trim().replace(/\s+/g, ' ') || 'Cash Customer'),
        quantity: totalQty,
        total,
        paid,
        dueDate: sale.paymentType === 'credit' && owed > 0 ? sale.dueDate || undefined : undefined,
        customerPhone: sale.phone || undefined,
      } : item))
      setProducts((current) => current.map((product) => {
        if (product.id === oldProduct?.id && product.id === selectedProduct.id) {
          return { ...product, stock: product.stock + oldSale.quantity - totalQty }
        }
        if (product.id === oldProduct?.id && product.id !== selectedProduct.id) {
          return { ...product, stock: product.stock + oldSale.quantity }
        }
        if (product.id === selectedProduct.id && product.id !== oldProduct?.id) {
          return { ...product, stock: product.stock - totalQty }
        }
        return product
      }))
      setEditingSale(null)
    } else {
      // Use the existing customer's exact name when the cashier types it in a
      // different case ("abebe" for "Abebe"), so the sale and any credit land
      // on that customer instead of a look-alike.
      const typedName = sale.customer.trim().replace(/\s+/g, ' ') || 'Cash Customer'
      const customerName = customers.find((c) => sameName(c.name, typedName))?.name ?? typedName
      const newSale: Sale = { id: nextSaleId(sales), productId: selectedProduct.id, productName: selectedProduct.name, customer: customerName, quantity: totalQty, total, paid, date: selectedIsoDate, time: localTime(), tz: 'local', dueDate: sale.paymentType === 'credit' && owed > 0 ? sale.dueDate || undefined : undefined, customerPhone: sale.phone || undefined, paymentType: sale.paymentType, unitPrice: Number(sale.unitPrice) || undefined }
      // Auto-save customer when recording a sale (if not already present)
      try {
        const name = customerName
        if (name && name !== 'Cash Customer') {
          const exists = customers.some((c) => c.name.toLowerCase() === name.toLowerCase())
          if (!exists) {
            const newCustomer: Customer = { id: `c-${Date.now()}`, name, phone: '', email: '', createdAt: localDate() }
            setCustomers((current) => [newCustomer, ...current])
          }
        }
      } catch (err) {
        // ignore if customers not provided
      }
      setSales((current) => [newSale, ...current])
      setProducts((current) => current.map((product) => product.id === selectedProduct.id ? { ...product, stock: product.stock - totalQty } : product))
      setSale({ productId: products[0]?.id ?? '', customer: '', phone: '', quantity: '1', unitPrice: products[0]?.sellPriceSet && products[0].sellPrice ? products[0].sellPrice.toString() : '', paid: '0', paymentType: 'credit', dueDate: '', sellBy: 'pack' })
    }
    setShowSale(false)
  }

  return <section className="sales-page"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SALES & PAYMENTS</div><h1>{t('heading.sales')}</h1><p>{t('heading.salesDesc')}</p></div><button className="primary-button" onClick={() => setShowSale(true)}><Plus size={18} /> {t('action.recordSale')}</button></section><section className="metric-grid"><Metric icon={<CircleDollarSign size={19} />} label={`Sales (${periodLabel})`} value={money.format(dayTotal)} detail={`${filteredSales.length} ${periodDetail}`} accent="orange" /><Metric icon={<ArrowDownToLine size={19} />} label={tx('Items sold')} value={(Math.round(filteredSales.reduce((sum, item) => { const pr = findSaleProduct(products, item); return sum + item.quantity / (isPackUnit(pr) ? (pr!.packQty || 1) : 1) }, 0) * 100) / 100).toString()} detail={`${selectedEthDate.monthNameEn} ${selectedEthDate.day}, ${selectedEthDate.year} E.C.`} accent="blue" /><Metric icon={<CircleDollarSign size={19} />} label={tx('Credit outstanding')} value={money.format(creditTotal)} detail="Across all customers" accent="red" /></section><div className="panel sales-panel"><div className="panel-header" style={{ flexWrap: 'wrap', gap: '12px' }}><div><h2>Sales Activity by Date</h2><p>Pick an Ethiopian date below to see what happened on that day.</p></div><div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}><EthiopianDatePicker label="Filter by Ethiopian Date" value={selectedIsoDate} onChange={(isoDate) => setSelectedIsoDate(isoDate)} /><div className="segmented-control"><button className={period === 'daily' ? 'active' : ''} onClick={() => setPeriod('daily')}>Day</button><button className={period === 'weekly' ? 'active' : ''} onClick={() => setPeriod('weekly')}>Week</button><button className={period === 'monthly' ? 'active' : ''} onClick={() => setPeriod('monthly')}>Month</button><button className={period === 'yearly' ? 'active' : ''} onClick={() => setPeriod('yearly')}>Year</button></div><SortSelect value={saleSort} onChange={setSaleSort} label="Sort sales" /></div></div><div className="table-toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search sales" value={saleQuery} onChange={(event) => setSaleQuery(event.target.value)} placeholder="Search by customer, item or sale number..." /></div></div><div className="table-wrap"><table><thead><tr><th>{tx('Sale')}</th><th>{tx('Customer')}</th><th>{tx('Quantity')}</th>{FIFO_COSTING && <th>{tx('Unit price')}</th>}<th>{tx('Total')}</th><th>{tx('Paid')}</th><th>{tx('Balance')}</th><th /></tr></thead><tbody>{shownSales.map((item) => <tr key={item.id}><td><div className="purchase-product"><div className="mini-product">{item.productName.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><b>{item.productName}</b><small>{item.id} · {formatDualDate(item.date)}</small></div></div></td><td>{item.customer}</td><td>{saleQtyLabel(item.quantity, findSaleProduct(products, item))}</td>{FIFO_COSTING && <td>{money.format(item.unitPrice ?? (item.quantity ? item.total / item.quantity : 0))}<small className="per-unit"> / {unitSymbolOf(findSaleProduct(products, item))}</small></td>}<td><b>{money.format(item.total)}</b></td><td>{money.format(item.paid)}</td><td><span className={item.paid >= item.total ? 'paid-pill' : 'credit-pill'}>{item.paid >= item.total ? 'Paid' : money.format(item.total - item.paid)}</span></td><td><button className="more-button" aria-label={`Manage ${item.id}`} onClick={() => setSelectedSale(item)}>•••</button></td></tr>)}</tbody></table>{filteredSales.length === 0 && <div className="empty-state">No sales recorded for {periodLabel} ({selectedIsoDate}).</div>}{filteredSales.length > 0 && shownSales.length === 0 && <div className="empty-state">No sales match your search.</div>}</div></div>{showSale && <SaleModal sale={sale} setSale={setSale} products={products} selectedProduct={selectedProduct} total={total} owed={owed} overpayment={overpayment} onProductChange={selectProduct} onClose={() => { setShowSale(false); setEditingSale(null); setSaleNotice('') }} onSubmit={recordSale} notice={saleNotice} available={available} modalTitle={editingSale ? 'Edit sale' : 'Record a sale'} submitLabel={editingSale ? 'Update sale' : 'Complete sale'} />}{selectedSale && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedSale(null)}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SALE ACTIONS</div><h2>{selectedSale.productName}</h2><p>{selectedSale.id} · {selectedSale.customer}</p></div><button className="close-button" onClick={() => setSelectedSale(null)} aria-label={tx('Close')}><X size={19} /></button></div><div className="modal-body"><div className="action-row"><button className="secondary-button" onClick={() => startEditSale(selectedSale)}>{tx('Edit')}</button><button className="secondary-button danger" onClick={() => deleteSale(selectedSale.id)}>{tx('Delete')}</button></div></div></div></div>}</section>
}

function SaleModal({ sale, setSale, products, selectedProduct, total, owed, overpayment, onProductChange, onClose, onSubmit, available, notice, modalTitle = 'Record a sale', submitLabel = 'Complete sale' }: { notice?: string; sale: { productId: string; customer: string; phone: string; quantity: string; unitPrice: string; paid: string; paymentType: string; dueDate: string; sellBy: string }; available?: number; setSale: React.Dispatch<React.SetStateAction<typeof sale>>; products: Product[]; selectedProduct?: Product; total: number; owed: number; overpayment: number; onProductChange: (id: string) => void; onClose: () => void; onSubmit: (event: React.FormEvent) => void; modalTitle?: string; submitLabel?: string }) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filteredProducts = query ? products.filter((product) => [product.name, product.sku ?? '', product.brand, product.category].join(' ').toLowerCase().includes(query)) : products
  const selectedUnit = selectedProduct?.unit || 'pcs'
  const selectedUnitLower = selectedUnit.toLowerCase()
  const isMeterUnit = /meter|roll|length|m\b/.test(selectedUnitLower) && !selectedUnitLower.includes('box')
  const packQty = selectedProduct?.packQty || 1
  const qty = Number(sale.quantity) || 0
  const totalBase = qty * packQty
  const baseLabel = isMeterUnit ? 'meters' : 'pcs'
  const isBoxUnit = selectedUnitLower.includes('box')
  const packedUnitName = isBoxUnit ? 'box(es)' : isMeterUnit ? 'roll(s)' : selectedUnit
  const baseSymbol = isMeterUnit ? 'm' : 'pcs'
  const onShelf = available ?? selectedProduct?.stock ?? 0
  const maxPacks = selectedProduct ? Math.floor(onShelf / packQty) : 0
  const sellingBase = sale.sellBy === 'base' || packQty <= 1
  const packWord = packUnitName(selectedProduct)
  const baseWord = baseUnitWord(selectedProduct)
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal wide-modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> NEW SALE</div><h2>{modalTitle}</h2><p>{selectedProduct ? `Stock: ${maxPacks} ${packedUnitName} (${selectedProduct.stock} ${baseSymbol})${packQty > 1 ? ` · ${packQty} ${baseSymbol} each` : ''}` : 'Stock: 0'}</p></div><button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button></div><form onSubmit={onSubmit}><div className="modal-form-grid"><label>{tx('Product')}<div className="product-search"><Search size={16} className="product-search-icon" /><input className="product-search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, SKU, brand or category..." /></div><div className="product-results product-results-scroll">{filteredProducts.length === 0 ? <div className="product-empty">No matching products. Try a different search.</div> : filteredProducts.map((product) => <button type="button" key={product.id} className={`product-option${product.id === sale.productId ? ' selected' : ''}`} onClick={() => onProductChange(product.id)}><span className="product-option-name">{product.name}{product.sku ? ` (${product.sku})` : ''}</span><span className="product-option-meta">{product.brand ? `${product.brand} · ` : ''}{packedQtyLabel(product.stock, product)} in stock</span></button>)}</div></label><label>{tx('Customer')} <span className="optional">Leave blank for walk-in</span><input value={sale.customer} onChange={(event) => setSale({ ...sale, customer: event.target.value })} placeholder="e.g. Abebe Kebede (or leave blank)" /></label><label>{tx('Phone')} <span className="optional">Optional</span><input value={sale.phone ?? ''} onChange={(event) => setSale({ ...sale, phone: event.target.value })} placeholder="Customer phone number" /></label>{packQty > 1 && <div className="payment-choice sell-by"><span>Sell by</span><div><button type="button" className={!sellingBase ? 'payment-option active' : 'payment-option'} onClick={() => setSale({ ...sale, sellBy: 'pack' })}>Whole {packWord}</button><button type="button" className={sellingBase ? 'payment-option active' : 'payment-option'} onClick={() => setSale({ ...sale, sellBy: 'base' })}>Single {baseWord}</button></div></div>}<label>{sellingBase ? `Quantity (${baseUnitSymbol(selectedProduct)})` : `Quantity (${pluralUnit(packWord, 2)} · ${packQty} ${baseUnitSymbol(selectedProduct)} each)`}<input min={sellingBase && isMeterUnit ? '0.01' : '1'} step={sellingBase && isMeterUnit ? 'any' : '1'} max={sellingBase ? (onShelf > 0 ? onShelf : undefined) : (maxPacks > 0 ? maxPacks : undefined)} required type="number" value={sale.quantity} onChange={(event) => setSale({ ...sale, quantity: event.target.value })} /></label>{!sellingBase && packQty > 1 && maxPacks === 0 ? <p className="warn-note" style={{ gridColumn: '1 / -1', margin: 0, fontSize: '0.8rem', fontWeight: 600 }}>Not enough stock for one {packedUnitName}. You have {selectedProduct?.stock} {baseLabel}; one {packedUnitName} holds {packQty} {baseLabel}.</p> : !sellingBase && packQty > 1 && Number(sale.quantity) > 0 ? <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 600 }}>{Number(sale.quantity)} {packedUnitName} ({totalBase} {baseSymbol})</p> : null}<label>Unit price ({isMeterUnit ? 'per meter' : 'per pc'} / ETB)<input min="0" step="0.01" required type="number" value={sale.unitPrice} onChange={(event) => setSale({ ...sale, unitPrice: event.target.value })} /></label><div className="payment-choice"><span>Payment option</span><div><button type="button" className={sale.paymentType === 'paid' ? 'payment-option active' : 'payment-option'} onClick={() => setSale({ ...sale, paymentType: 'paid', paid: total.toFixed(2) })}>{tx('Paid in full')}</button><button type="button" className={sale.paymentType === 'credit' ? 'payment-option active' : 'payment-option'} onClick={() => setSale({ ...sale, paymentType: 'credit', paid: '0' })}>{tx('Credit sale')}</button></div></div><label>{tx('Amount paid')}<input min="0" step="0.01" required type="number" value={sale.paid} onChange={(event) => setSale({ ...sale, paid: event.target.value, paymentType: Number(event.target.value) >= total ? 'paid' : 'credit' })} /></label><div className="sale-summary"><div><span>Total sale</span><strong>{money.format(total)}</strong></div><div><span>{owed > 0 ? 'Credit owed' : overpayment > 0 ? 'Change due' : 'Payment status'}</span><strong className={owed > 0 ? 'summary-credit' : ''}>{owed > 0 ? money.format(owed) : overpayment > 0 ? money.format(overpayment) : 'Fully paid'}</strong></div></div></div>{sale.paymentType === 'credit' && owed > 0 && <label>{tx('Credit due date')}<input required type="date" value={sale.dueDate} onChange={(event) => setSale({ ...sale, dueDate: event.target.value })} /></label>}{notice && <p className="form-message warn-note" role="alert">{notice}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{tx('Cancel')}</button><button type="submit" className="primary-button"><ShoppingCart size={17} /> {submitLabel}</button></div></form></div></div>
}

/**
 * Every purchase batch of one item: who it was bought from, at what price,
 * how much was bought and how much is left. The batch that sells next (FIFO)
 * is marked.
 */
function ItemDetailModal({ product, batches, onClose }: { product: Product; batches: Batch[]; onClose: () => void }) {
  const [view, setView] = useState<'next' | 'all'>('next')
  const unit = isRollUnit(product.unit) ? 'm' : /kilo|kg/i.test(product.unit || '') ? 'kg' : 'pc'
  const nextKey = batches.find((b) => b.left > 0)?.key
  // "Next to sell": what is still in stock, in the order it will sell.
  // "All purchases": every batch, newest first.
  const rows = view === 'next' ? batches.filter((b) => b.left > 0) : [...batches].reverse()
  const value = stockValueOf(batches)
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal wide-modal item-detail-modal">
    <div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> ITEM DETAIL</div><h2>{product.name}</h2><p>{tx('In stock')}: {packBreakdown(product.stock, product)} · {tx('Stock value')}: {money.format(value)}</p></div><button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button></div>
    <div className="detail-toolbar"><SortMenu value={view} onChange={setView} label="Show batches" options={[['next', 'Next to sell'], ['all', 'All purchases']]} /><small>Oldest stock sells first (FIFO). Each sale takes the price of the batch it comes from.</small></div>
    <div className="table-wrap"><table><thead><tr><th>{tx('Date')}</th><th>{tx('Bought from')}</th><th>{tx('Unit price')}</th><th>{tx('Bought')}</th><th>{tx('Left')}</th><th /></tr></thead><tbody>
      {rows.length === 0 ? <tr><td colSpan={6}><em>{view === 'next' ? 'Nothing in stock.' : 'No purchases recorded for this item yet.'}</em></td></tr> : rows.map((b) => <tr key={b.key} className={b.left <= 0 ? 'batch-used' : ''}>
        <td>{b.date ? formatDualDate(b.date) : '—'}</td>
        <td>{b.kind === 'opening' ? <span title="Stock entered without a purchase. Valued at the item's cost price.">{tx('Opening stock')}</span> : b.supplier}</td>
        <td>{money.format(b.unitCost)}<small className="per-unit"> / {unit}</small></td>
        <td>{packBreakdown(b.bought, product)}</td>
        <td><b>{packBreakdown(b.left, product)}</b></td>
        <td>{b.key === nextKey ? <span className="next-pill">{tx('Sells next')}</span> : b.left <= 0 ? <span className="used-pill">{tx('Sold out')}</span> : null}</td>
      </tr>)}
    </tbody></table></div>
  </div></div>
}

function AddItemModal({ item, setItem, onClose, onSubmit, submitLabel, modalTitle }: { item: { name: string; sku: string; brand: string; category: string; unit: string; packQty: string; stock: string; threshold: string; costPrice: string; sellPrice: string }; setItem: React.Dispatch<React.SetStateAction<typeof item>>; onClose: () => void; onSubmit: (event: React.FormEvent) => void; submitLabel: string; modalTitle: string }) {
  const UNIT_PRESETS = ['pcs', 'box', 'kilo (kg)', 'roll (meter)']
  const isCustomUnit = !UNIT_PRESETS.includes(item.unit)
  const showPackQty = item.unit !== 'pcs' && item.unit !== ''
  const isRollMeter = item.unit === 'roll (meter)'
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal"><div className="modal-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> INVENTORY ITEM</div><h2>{modalTitle}</h2><p>Create or update a product for your catalog.</p></div><button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button></div><form onSubmit={onSubmit}><label>{tx('Item name')}<input required value={item.name} onChange={(event) => setItem({ ...item, name: event.target.value })} placeholder="e.g. PVC pipe 50mm" /></label><div className="form-row"><label>SKU <span className="optional">Optional</span><input value={item.sku} onChange={(event) => setItem({ ...item, sku: event.target.value })} placeholder="PIP-PVC-050" /></label><label>{tx('Brand')}<input value={item.brand} onChange={(event) => setItem({ ...item, brand: event.target.value })} placeholder="AquaFlow" /></label></div><label>{tx('Category')}<select value={item.category} onChange={(event) => setItem({ ...item, category: event.target.value })}><option>Pipes</option><option>Valves</option><option>Pumps</option><option>Fittings</option><option>Water storage</option><option>Meters</option><option>Other</option></select></label>{isCustomUnit ? <label>{tx('Unit')} <span className="optional">Custom</span><input required value={item.unit} onChange={(event) => setItem({ ...item, unit: event.target.value })} placeholder="e.g. dozen, pair, bag..." /><select value="__custom" onChange={(event) => { const v = event.target.value; if (v !== '__custom') setItem({ ...item, unit: v }) }}><option value="__custom">Custom…</option>{UNIT_PRESETS.map((u) => <option key={u} value={u}>{u}</option>)}</select></label> : <label>{tx('Unit')}<select value={item.unit} onChange={(event) => { const v = event.target.value; if (v === '__custom') setItem({ ...item, unit: '' }); else setItem({ ...item, unit: v }) }}>{UNIT_PRESETS.map((u) => <option key={u} value={u}>{u}</option>)}<option value="__custom">Other (custom)…</option></select></label>}{showPackQty && (isRollMeter ? <label>Meters per roll<input min="1" required type="number" value={item.packQty} onChange={(event) => setItem({ ...item, packQty: event.target.value })} placeholder="e.g. 100 meters per roll" /></label> : <label>Units per {item.unit} <span className="optional">pcs</span><input min="1" required type="number" value={item.packQty} onChange={(event) => setItem({ ...item, packQty: event.target.value })} placeholder={`e.g. 50 pcs per ${item.unit}`} /></label>)}<div className="form-row"><label>Opening stock {showPackQty ? `(${item.unit})` : '(pcs)'}<input min="0" required type="number" value={item.stock} onChange={(event) => setItem({ ...item, stock: event.target.value })} /></label><label>{tx('Reorder threshold')}<input min="0" required type="number" value={item.threshold} onChange={(event) => setItem({ ...item, threshold: event.target.value })} /></label></div><label>{FIFO_COSTING ? tx('Opening stock cost') : tx('Cost price')} ({isRollMeter ? 'per meter' : /kilo|kg/i.test(item.unit) ? 'per kg' : 'per piece'}){FIFO_COSTING && <span className="optional">Only for stock entered here, not bought through Purchases. Purchases keep their own prices.</span>}<input min="0" step="0.01" required type="number" value={item.costPrice} onChange={(event) => setItem({ ...item, costPrice: event.target.value })} /></label><label>{tx('Selling price')} ({isRollMeter ? 'per meter' : /kilo|kg/i.test(item.unit) ? 'per kg' : 'per piece'})<span className="optional">Pre-filled when you record a sale</span><input min="0" step="0.01" type="number" value={item.sellPrice} onChange={(event) => setItem({ ...item, sellPrice: event.target.value })} placeholder="Leave blank to type it at each sale" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>{tx('Cancel')}</button><button type="submit" className="primary-button"><Plus size={17} /> {submitLabel}</button></div></form></div></div>
}
function EditableSettingsPage({ currentUser, onReset, darkMode, toggleDark, branch, setBranch, t, exportSnapshot, replaceAll, profileName, setProfileName, address, setAddress }: { currentUser: LocalAccount | null; onReset: () => void; darkMode: boolean; toggleDark: () => void; branch: string; setBranch: (b: string) => void; t: (k: TranslationKey) => string; profileName: string; setProfileName: (v: string) => void; address: string; setAddress: (v: string) => void; exportSnapshot: () => Snapshot; replaceAll: (s: Partial<Snapshot>) => Promise<void> }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [lastBackup, setLastBackup] = useState('')
  const [cloud, setCloud] = useState<IcloudStatus | null>(null)
  const [showRestore, setShowRestore] = useState(false)

  const refreshCloud = useCallback(() => {
    window.desktop?.icloudStatus?.().then(setCloud).catch(() => {})
  }, [])
  useEffect(() => {
    refreshCloud()
    const timer = window.setInterval(refreshCloud, 30000)
    return () => window.clearInterval(timer)
  }, [refreshCloud])

  // File-level backup of the SQLite database, done by the desktop shell.
  // The shell also does this automatically (hourly when something changed,
  // and on quit) and copies each one to iCloud Drive on a Mac.
  async function backupNow() {
    if (!window.desktop) return
    setBusy(true)
    try {
      const result = await window.desktop.backupNow()
      if (!result.ok) setLastBackup(`Backup failed: ${result.message ?? 'unknown error'}`)
      else if (result.cloud?.ok) setLastBackup('Backup saved on this Mac and copied to iCloud Drive.')
      else if (result.cloud && result.cloud.kind !== 'unsupported') setLastBackup(`Backup saved on this computer, but the iCloud copy failed: ${result.cloud.message ?? 'iCloud Drive is off'}`)
      else setLastBackup('Backup saved on this computer.')
    } finally {
      setBusy(false)
      refreshCloud()
    }
  }

  // Backups come straight from the in-memory snapshot, which mirrors SQLite.
  // The previous version read localStorage and left `expenses` out entirely.
  function exportDatabase() {
    const snap = exportSnapshot()
    const payload = { app: 'mame', version: 2, exportedAt: new Date().toISOString(), branch, ...snap }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mame-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        const required = ['products', 'purchases', 'sales', 'customers', 'suppliers'] as const
        if (!parsed || typeof parsed !== 'object' || !['mame', 'avanza'].includes(parsed.app) || !required.every((k) => Array.isArray(parsed[k]))) {
          window.alert('Invalid backup file. Please choose a valid Mame backup.')
          return
        }
        if (!window.confirm('This will REPLACE all current data with the backup. Your current data is saved first as a "Before restore" backup. Continue?')) return
        setBusy(true)
        if (window.desktop?.backupBeforeRestore) {
          const safety = await window.desktop.backupBeforeRestore()
          if (!safety.ok) { window.alert(`Nothing was changed: the current data could not be backed up first (${safety.message ?? 'unknown error'}).`); return }
        }
        // Version-1 backups (from the localStorage era) had no expenses and kept
        // branch at the top level; both are handled here.
        const settings: Record<string, string> = { ...(parsed.settings ?? {}) }
        if (typeof parsed.branch === 'string' && parsed.branch) settings.branch = parsed.branch
        await replaceAll({
          products: parsed.products, purchases: parsed.purchases, sales: parsed.sales,
          customers: parsed.customers, suppliers: parsed.suppliers,
          expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
          settings,
        })
        if (settings.branch) setBranch(settings.branch)
        window.alert('Backup restored.')
      } catch (err) {
        window.alert('Could not restore this file: ' + (err instanceof Error ? err.message : 'not a valid Mame backup'))
      } finally {
        setBusy(false)
      }
    }
    reader.readAsText(file)
  }

  return <section className="settings-page"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> WORKSPACE ADMIN</div><h1>{t('heading.settings')}</h1><p>{t('heading.settingsDesc')}</p></div></section><div className="settings-grid"><div className="panel settings-panel"><div className="panel-header"><div><h2>{tx('Account')}</h2><p>The name shown in the top bar and on printed reports.</p></div></div><div className="settings-list"><div><span>Owner name</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Shop Owner" style={{border:'none',textAlign:'right',fontWeight:700,fontSize:'inherit',color:'inherit',background:'transparent'}} /></div></div></div><div className="panel settings-panel"><div className="panel-header"><div><h2>{tx('Workspace')}</h2><p>{tx('Current operational workspace details.')}</p></div></div><div className="settings-list"><div><span>{tx('Workspace')}</span><strong>Mame</strong></div><div><span>{tx('Address')}</span><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Shop address" style={{border:'none',textAlign:'right',fontWeight:700,fontSize:'inherit',color:'inherit',background:'transparent'}} /></div><div><span>{tx('Branch')}</span><input value={branch} onChange={(event) => setBranch(event.target.value)} style={{border:'none',textAlign:'right',fontWeight:700,fontSize:'inherit',color:'inherit',background:'transparent'}} /></div><div><span>{tx('Currency')}</span><strong>Birr (ETB)</strong></div></div></div>{window.desktop && cloud?.supported && <IcloudPanel cloud={cloud} busy={busy} onBackupNow={backupNow} />}<div className="panel settings-panel"><div className="panel-header"><div><h2>{tx('Data backup')}</h2><p>{tx('Export all records to a file, or restore from a Mame backup file.')}</p></div></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={exportDatabase} disabled={busy}>{tx('Export database')}</button><button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>{tx('Import database')}</button>{window.desktop && <button type="button" className="secondary-button" onClick={backupNow} disabled={busy}>{tx('Back up now')}</button>}{window.desktop && <button type="button" className="secondary-button" onClick={() => setShowRestore(true)} disabled={busy}>{tx('Restore from backup')}</button>}{window.desktop && <button type="button" className="secondary-button" onClick={() => window.desktop?.openBackupFolder()}>{tx('Open backup folder')}</button>}</div>{lastBackup && <p className="form-message">{lastBackup}</p>}<input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={handleImportFile} /><p className="form-message" style={{ color: 'var(--muted)' }}>Tip: keep a recent export file in a safe place. Importing replaces all current data.</p>{showRestore && <RestoreBackupModal onClose={() => { setShowRestore(false); refreshCloud() }} replaceAll={replaceAll} onDone={(message) => setLastBackup(message)} />}</div><div className="panel settings-panel danger-panel"><div className="panel-header"><div><h2>{tx('Reset data')}</h2><p>{tx('Clear all products, purchases, sales, customers, and suppliers.')}</p></div></div><button className="secondary-button danger" onClick={() => { if (window.confirm('This will delete all products, purchases, sales, customers, suppliers and expenses. A backup of the current data is made first (Settings > Restore from backup, marked "Before restore"). Continue?')) { onReset() } }}>{tx('Reset All Data')}</button></div></div></section>
}

function SectionPlaceholder({ section, onBack }: { section: Section; onBack: () => void }) { const details: Record<Section, { eyebrow: string; title: string; description: string }> = { Overview: { eyebrow: 'WORKSPACE OVERVIEW', title: 'Overview', description: 'Your operations at a glance.' }, Sales: { eyebrow: 'SALES OPERATIONS', title: 'Sales', description: 'Sales and customer payments will live here.' }, Purchases: { eyebrow: 'INVENTORY MANAGEMENT', title: 'Purchases', description: 'Manage incoming stock and supplies.' }, Inventory: { eyebrow: 'STOCK CONTROL', title: 'Inventory', description: 'Track products, stock levels, and pricing.' }, Customers: { eyebrow: 'CUSTOMER ACCOUNTS', title: 'Customers', description: 'Manage customers and outstanding orders.' }, Suppliers: { eyebrow: 'SUPPLY NETWORK', title: 'Suppliers', description: 'Keep your suppliers organized and ready to deliver.' }, Expenses: { eyebrow: 'EXPENSE TRACKING', title: 'Expenses', description: 'Track your business operating costs.' }, Reports: { eyebrow: 'BUSINESS INTELLIGENCE', title: 'Reports', description: 'Review purchase, sales, profit, and receipt activity.' }, Graph: { eyebrow: 'VISUAL ANALYTICS', title: 'Graph View', description: 'Visualize trends, category share, and transaction volume.' }, Settings: { eyebrow: 'WORKSPACE ADMIN', title: 'Settings', description: 'Configure your Mame workspace and branch access.' } }; const detail = details[section]; return <section className="section-placeholder"><div className="eyebrow"><span className="eyebrow-line" /> {detail.eyebrow}</div><h1>{detail.title}</h1><p>{detail.description}</p><div className="placeholder-panel"><div className="placeholder-icon"><Boxes size={21} /></div><div><h2>{detail.title} module</h2><p>This section is connected and ready for its dedicated workflow. Purchases is the first completed module.</p></div><button className="primary-button" onClick={onBack}>Open Purchases <ArrowUpRight size={16} /></button></div></section> }
function Metric({ icon, label, value, detail, accent }: { icon: React.ReactNode; label: string; value: string; detail: string; accent: string }) { return <div className="metric-card"><div className={`metric-icon ${accent}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div> }
function PurchaseTable({ purchases, products, onMoreClick, emptyMessage }: { purchases: Purchase[]; products?: Product[]; onMoreClick: (purchase: Purchase) => void; emptyMessage?: string }) { const skuFor = (name: string) => products?.find((item) => item.name === name)?.sku; return <div className="table-wrap"><table className="purchase-table"><thead><tr><th>{tx('Purchase')}</th><th>{tx('Supplier')}</th><th>{tx('Received')}</th><th>{tx('Quantity')}</th>{FIFO_COSTING && <th>{tx('Unit cost')}</th>}<th>{tx('Total cost')}</th><th>{tx('Payment')}</th><th /></tr></thead><tbody>{purchases.map((purchase) => <tr key={purchase.id}><td><div className="purchase-product"><div className="mini-product">{purchase.productName.split(' ').map((word) => word[0]).join('').slice(0, 2)}</div><div><b>{purchase.productName}</b><small>{skuFor(purchase.productName) ? `SKU ${skuFor(purchase.productName)}` : ''}{purchase.reference ? `${skuFor(purchase.productName) ? ' · ' : ''}${purchase.reference}` : ''}</small></div></div></td><td>{purchase.supplier}</td><td>{dateTimeLabel(purchase.date, shownTime(purchase))}</td><td><span className="quantity-pill">+{purchaseQtyLabel(purchase, products?.find((item) => item.id === purchase.productId) ?? products?.find((item) => item.name === purchase.productName))}</span></td>{FIFO_COSTING && <td>{money.format(purchase.unitCost || 0)}<small className="per-unit"> / {unitSymbolOf(products?.find((item) => item.id === purchase.productId))}</small></td>}<td><b>{money.format(purchaseTotalCost(purchase))}</b></td><td>{purchaseOwed(purchase) > 0 ? <span className="credit-pill">Owe {money.format(purchaseOwed(purchase))}</span> : <span className="paid-pill">{tx('Paid')}</span>}</td><td><button className="more-button" onClick={() => onMoreClick(purchase)} aria-label={`Open ${purchase.reference}`}>•••</button></td></tr>)}</tbody></table>{purchases.length === 0 && <div className="empty-state">{emptyMessage ?? 'No purchases match your search.'}</div>}</div> }
function PurchaseModal({ form, setForm, products, onClose, onSubmit, submitLabel, modalTitle }: { form: { productId: string; supplier: string; quantity: string; unitCost: string; reference: string; paymentType: string; paid: string; dueDate: string; buyBy: string }; setForm: React.Dispatch<React.SetStateAction<typeof form>>; products: Product[]; onClose: () => void; onSubmit: (event: React.FormEvent) => void; submitLabel: string; modalTitle: string }) {
  const product = products.find((item) => item.id === form.productId) ?? products[0]
  const isMeterUnit = !!(product && product.unit && product.unit.toLowerCase().includes('meter'))
  const canBuyLoose = PURCHASE_BY_PIECE && (product?.packQty || 1) > 1
  const buyingLoose = canBuyLoose && form.buyBy === 'base'
  const receivedBase = (Number(form.quantity) || 0) * (buyingLoose ? 1 : (product?.packQty || 1))
  const purchaseTotal = Math.round(receivedBase * (Number(form.unitCost) || 0) * 100) / 100

  if (!product) {
    return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal wide-modal">
        <div className="modal-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> INVENTORY IN</div>
            <h2>{modalTitle}</h2>
            <p>No items available to record a purchase for.</p>
          </div>
          <button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button>
        </div>
        <div className="modal-body">
          <div className="empty-state">You need at least one item before recording a purchase. Add an item on the <b>{tx('Items')}</b> page first, then come back to record stock.</div>
        </div>
        <div className="modal-actions"><button className="primary-button" onClick={onClose}>{tx('Close')}</button></div>
      </div>
    </div>
  }

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal wide-modal">
      <div className="modal-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> INVENTORY IN</div>
          <h2>{modalTitle}</h2>
          <p>Add stock to {product.name} at this branch.</p>
        </div>
        <button className="close-button" onClick={onClose} aria-label={tx('Close')}><X size={19} /></button>
      </div>
      <form onSubmit={onSubmit}>
        <div className="modal-form-grid vertical">
          <label>Product{product && <small style={{ display: 'block', margin: '4px 0 6px', color: 'var(--muted)', fontFamily: "'DM Mono',monospace", fontSize: 10 }}>{product.unit ? `Unit: ${product.unit}${product.packQty ? ` · ${isMeterUnit ? `${product.packQty} meters per ${product.unit.split(' (')[0]}` : `${product.packQty} pcs each`}` : ''}` : ''}</small>}<select value={form.productId} onChange={(event) => { const next = products.find((item) => item.id === event.target.value); setForm({ ...form, productId: event.target.value, unitCost: FIFO_COSTING ? form.unitCost : next ? String(next.costPrice ?? '') : form.unitCost }) }}>{products.map((item) => <option key={item.id} value={item.id}>{item.name}{item.sku ? ` · ${item.sku}` : ''}</option>)}</select></label>
          <label>{tx('Supplier')} <span className="optional">Optional</span><input value={form.supplier} onChange={(event) => setForm({ ...form, supplier: event.target.value })} placeholder="Unknown supplier" /></label>
          {canBuyLoose && <div className="payment-choice sell-by"><span>{tx('Buy by')}</span><div><button type="button" className={`payment-option${!buyingLoose ? ' active' : ''}`} onClick={() => setForm({ ...form, buyBy: 'pack' })}>{tx('Whole')} {packUnitName(product)}</button><button type="button" className={`payment-option${buyingLoose ? ' active' : ''}`} onClick={() => setForm({ ...form, buyBy: 'base' })}>{tx('Single')} {baseUnitWord(product)}</button></div></div>}<label>Quantity ({buyingLoose ? (isMeterUnit ? 'meters' : 'pcs') : (product.unit || 'units')})<input min={buyingLoose ? '0.01' : '1'} step={buyingLoose ? 'any' : '1'} required type="number" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>{product.packQty && product.packQty > 1 ? <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 600 }}>{buyingLoose ? `${packBreakdown(receivedBase, product)} added to stock` : `${form.quantity || 0} ${product.unit} = ${receivedBase} ${isMeterUnit ? 'meters' : 'pcs'}`}</p> : null}
          <label>Unit cost {product.packQty ? `(per ${isMeterUnit ? 'meter' : 'pcs'})` : ''}<input min="0" step="0.01" required type="number" value={form.unitCost} onChange={(event) => setForm({ ...form, unitCost: event.target.value })} /></label>
          <div className="form-total"><span>{tx('Total cost')}</span><strong>{money.format(purchaseTotal)}</strong></div><div className="payment-choice"><span>{tx('Payment')}</span><div><button type="button" className={form.paymentType !== 'credit' ? 'payment-option active' : 'payment-option'} onClick={() => setForm({ ...form, paymentType: 'paid' })}>{tx('Paid in full')}</button><button type="button" className={form.paymentType === 'credit' ? 'payment-option active' : 'payment-option'} onClick={() => setForm({ ...form, paymentType: 'credit', paid: form.paid || '0' })}>{tx('On credit')}</button></div></div>{form.paymentType === 'credit' && <><label>{tx('Amount paid now')} <span className="optional">ETB</span><input min="0" max={purchaseTotal || undefined} step="0.01" type="number" value={form.paid} onChange={(event) => setForm({ ...form, paid: event.target.value })} /></label><label>{tx('Due date')} <span className="optional">Optional</span><input type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} /></label><div className="form-total owed-total"><span>{tx('Owed to supplier')}</span><strong>{money.format(Math.max(purchaseTotal - (Number(form.paid) || 0), 0))}</strong></div>{!form.supplier.trim() && <p className="form-message warn-note" style={{ margin: 0 }}>Enter the supplier's name above so the app knows who is owed.</p>}</>}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{tx('Cancel')}</button>
          <button type="submit" className="primary-button">{submitLabel}</button>
        </div>
      </form>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
