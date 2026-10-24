import { useCallback, useEffect, useRef, useState } from 'react'
import type { Product, Purchase, Sale, Customer, Supplier, Expense } from './types'

/* ---------------------------------------------------------------
   Data store.

   Every collection the app works with lives in SQLite on the local
   machine, behind the small HTTP API in scripts/server/store.ts.

   The UI code mutates plain arrays with setState exactly as it did
   before. This module watches those arrays, works out which records
   changed by id, and writes only those to the database. That keeps
   all the existing business logic untouched while moving the data
   out of localStorage (which is browser cache, not storage).
   --------------------------------------------------------------- */

export type SyncStatus = 'loading' | 'ready' | 'saving' | 'error' | 'offline'

type WithId = { id: string }

/* ---- API base ------------------------------------------------- */
// In development, Vite proxies /api to the backend. In the packaged app
// the page is loaded from file://, where a relative /api would resolve to
// the filesystem, so we need the absolute loopback address.
function apiBase(): string {
  const fromShell = (window as any).desktop?.apiBase
  if (typeof fromShell === 'string' && fromShell) return fromShell
  if (window.location.protocol === 'file:') return 'http://127.0.0.1:3001'
  return ''
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiBase() + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try { msg = (await res.json()).message ?? msg } catch { /* not json */ }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const storeApi = {
  health: () => request<{ ok: boolean }>('/api/health'),
  snapshot: () => request<Snapshot>('/api/store'),
  batch: (collection: string, upserts: WithId[], deletes: string[]) =>
    request<{ ok: boolean }>(`/api/store/${collection}/batch`, {
      method: 'POST',
      body: JSON.stringify({ upserts, deletes }),
      // Let an in-flight save finish even if the window is closing.
      keepalive: true,
    }),
  replaceAll: (snapshot: Partial<Snapshot>) =>
    request<{ ok: boolean }>('/api/store', { method: 'PUT', body: JSON.stringify(snapshot) }),
  setSetting: (key: string, value: string) =>
    request<{ ok: boolean }>(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
      keepalive: true,
    }),
}

export type Snapshot = {
  products: Product[]
  purchases: Purchase[]
  sales: Sale[]
  customers: Customer[]
  suppliers: Supplier[]
  expenses: Expense[]
  settings: Record<string, string>
}

export const COLLECTIONS = ['products', 'purchases', 'sales', 'customers', 'suppliers', 'expenses'] as const
export type CollectionName = (typeof COLLECTIONS)[number]

/* ---- one-time migration from localStorage --------------------- */
// Versions before this one kept everything in localStorage under
// 'mame-<collection>'. On first launch after upgrading, if the SQLite
// store is empty and localStorage has data, move it across so the shop
// does not open to an empty screen. localStorage is then cleared so it
// can never become a second source of truth again.
const LEGACY_PREFIX = 'mame-'

function readLegacy<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(LEGACY_PREFIX + key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function legacySnapshot(): Partial<Snapshot> | null {
  const snap: Partial<Snapshot> = {}
  let any = false
  for (const c of COLLECTIONS) {
    const rows = readLegacy<WithId>(c)
    if (rows.length) any = true
    ;(snap as any)[c] = rows
  }
  const branch = localStorage.getItem(LEGACY_PREFIX + 'branch')
  if (branch) { snap.settings = { branch }; any = true }
  return any ? snap : null
}

function clearLegacy() {
  for (const c of COLLECTIONS) localStorage.removeItem(LEGACY_PREFIX + c)
  localStorage.removeItem(LEGACY_PREFIX + 'branch')
  localStorage.removeItem(LEGACY_PREFIX + 'auth')
}

function snapshotIsEmpty(s: Snapshot): boolean {
  return COLLECTIONS.every((c) => (s[c] as unknown[]).length === 0) && !s.settings?.branch
}

/* ---- sync engine ---------------------------------------------- */
// One serial queue for all writes so they reach the database in the
// order the user made them. Failures retry with backoff; the UI is told
// through `status` so it can show an unsaved-changes warning.
class SyncQueue {
  private chain: Promise<void> = Promise.resolve()
  private pending = 0
  private listeners = new Set<(s: SyncStatus) => void>()
  private status: SyncStatus = 'ready'

  subscribe(fn: (s: SyncStatus) => void) {
    this.listeners.add(fn)
    fn(this.status)
    return () => { this.listeners.delete(fn) }
  }
  private set(s: SyncStatus) {
    if (s === this.status) return
    this.status = s
    this.listeners.forEach((fn) => fn(s))
  }
  get hasPending() { return this.pending > 0 }

  push(job: () => Promise<unknown>) {
    this.pending += 1
    this.set('saving')
    this.chain = this.chain.then(async () => {
      let delay = 400
      for (let attempt = 0; ; attempt += 1) {
        try {
          await job()
          break
        } catch (err) {
          console.error('[store] write failed, retrying', err)
          this.set('error')
          // Never give up. This used to drop the change after ~1.5 minutes:
          // the screen kept showing it, but it was gone after a restart. The
          // backend runs inside the app, so a failure here means the disk is
          // full or locked; keep retrying (every 15 s at most) until it works.
          void attempt
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 2, 15000)
        }
      }
      // Reaching here means the write succeeded (failures retry forever), so
      // clear any "Not saved" left from earlier attempts.
      this.pending -= 1
      this.set(this.pending === 0 ? 'ready' : 'saving')
    })
    return this.chain
  }
  markHealthy() { if (this.pending === 0) this.set('ready') }
  /** Resolves once every queued write has reached the database (false on timeout). */
  async whenIdle(timeoutMs = 15000): Promise<boolean> {
    const until = Date.now() + timeoutMs
    while (this.pending > 0) {
      if (Date.now() > until) return false
      await new Promise((r) => setTimeout(r, 100))
    }
    return true
  }
}

export const syncQueue = new SyncQueue()

/** Diff two arrays by id and return what has to be written. */
function diffById<T extends WithId>(
  lastSynced: Map<string, string>,
  next: T[],
): { upserts: T[]; deletes: string[]; nextMap: Map<string, string> } {
  const upserts: T[] = []
  const nextMap = new Map<string, string>()
  for (const rec of next) {
    const id = String(rec.id)
    const body = JSON.stringify(rec)
    nextMap.set(id, body)
    if (lastSynced.get(id) !== body) upserts.push(rec)
  }
  const deletes: string[] = []
  for (const id of lastSynced.keys()) if (!nextMap.has(id)) deletes.push(id)
  return { upserts, deletes, nextMap }
}

/* ---- the hook ------------------------------------------------- */
type Setter<T> = React.Dispatch<React.SetStateAction<T>>

export type ShopData = {
  ready: boolean
  loadError: string | null
  status: SyncStatus
  reload: () => Promise<void>
  products: Product[]; setProducts: Setter<Product[]>
  purchases: Purchase[]; setPurchases: Setter<Purchase[]>
  sales: Sale[]; setSales: Setter<Sale[]>
  customers: Customer[]; setCustomers: Setter<Customer[]>
  suppliers: Supplier[]; setSuppliers: Setter<Supplier[]>
  expenses: Expense[]; setExpenses: Setter<Expense[]>
  branch: string; setBranch: (b: string) => void
  profileName: string; setProfileName: (v: string) => void
  address: string; setAddress: (v: string) => void
  /** Replace every collection at once (import / reset). */
  replaceAll: (snapshot: Partial<Snapshot>) => Promise<void>
  /** Current in-memory data as a backup payload. */
  exportSnapshot: () => Snapshot
}

function useSyncedCollection<T extends WithId>(
  name: CollectionName,
  loaded: boolean,
  initial: T[],
): [T[], Setter<T[]>, (rows: T[]) => void] {
  const [rows, setRows] = useState<T[]>(initial)
  const synced = useRef<Map<string, string>>(new Map())
  const primed = useRef(false)

  // Adopt freshly loaded data without treating it as a change to write.
  const adopt = useCallback((fresh: T[]) => {
    synced.current = new Map(fresh.map((r) => [String(r.id), JSON.stringify(r)]))
    primed.current = true
    setRows(fresh)
  }, [])

  useEffect(() => {
    if (!loaded || !primed.current) return
    const { upserts, deletes, nextMap } = diffById(synced.current, rows)
    if (upserts.length === 0 && deletes.length === 0) return
    // Optimistically record what we are about to write so a second render
    // in the same tick does not resend the same records.
    synced.current = nextMap
    syncQueue.push(() => storeApi.batch(name, upserts, deletes))
  }, [rows, loaded, name])

  return [rows, setRows, adopt]
}

// Neutral defaults. Every shop fills these in from Settings; shipping one
// customer's real branch and address as the default showed the next
// customer another shop's details as if they were their own.
const DEFAULT_BRANCH = 'Main Branch'
const DEFAULT_ADDRESS = ''

export function useShopData(): ShopData {
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [status, setStatus] = useState<SyncStatus>('loading')

  const [products, setProducts, adoptProducts] = useSyncedCollection<Product>('products', ready, [])
  const [purchases, setPurchases, adoptPurchases] = useSyncedCollection<Purchase>('purchases', ready, [])
  const [sales, setSales, adoptSales] = useSyncedCollection<Sale>('sales', ready, [])
  const [customers, setCustomers, adoptCustomers] = useSyncedCollection<Customer>('customers', ready, [])
  const [suppliers, setSuppliers, adoptSuppliers] = useSyncedCollection<Supplier>('suppliers', ready, [])
  const [expenses, setExpenses, adoptExpenses] = useSyncedCollection<Expense>('expenses', ready, [])
  const [branch, setBranchState] = useState(DEFAULT_BRANCH)
  const [profileName, setProfileNameState] = useState('Shop Owner')
  const [address, setAddressState] = useState(DEFAULT_ADDRESS)

  const adoptAll = useCallback((s: Snapshot) => {
    adoptProducts(s.products ?? [])
    adoptPurchases(s.purchases ?? [])
    adoptSales(s.sales ?? [])
    adoptCustomers(s.customers ?? [])
    adoptSuppliers(s.suppliers ?? [])
    adoptExpenses(s.expenses ?? [])
    setBranchState(s.settings?.branch || DEFAULT_BRANCH)
    setProfileNameState(s.settings?.profileName || 'Shop Owner')
    setAddressState(s.settings?.address ?? DEFAULT_ADDRESS)
  }, [adoptProducts, adoptPurchases, adoptSales, adoptCustomers, adoptSuppliers, adoptExpenses])

  const load = useCallback(async () => {
    setLoadError(null)
    // The backend is spawned by the shell just before the window opens;
    // give it a moment rather than failing on the first attempt.
    let snap: Snapshot | null = null
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 15 && !snap; attempt += 1) {
      try {
        snap = await storeApi.snapshot()
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 400 + attempt * 200))
      }
    }
    if (!snap) {
      setLoadError(lastErr instanceof Error ? lastErr.message : 'Could not reach the local database')
      setStatus('offline')
      return
    }
    // First launch after upgrading from the localStorage version.
    if (snapshotIsEmpty(snap)) {
      const legacy = legacySnapshot()
      if (legacy) {
        try {
          await storeApi.replaceAll(legacy)
          snap = await storeApi.snapshot()
          clearLegacy()
          console.info('[store] migrated data from localStorage into SQLite')
        } catch (err) {
          console.error('[store] migration failed, leaving localStorage intact', err)
        }
      }
    } else {
      // Store already has data: any legacy copy is stale and must not linger.
      clearLegacy()
    }
    // Backfill productId on sales recorded before sales carried one, so a
    // later rename cannot break the stock restore on delete/edit.
    const needsLink = (snap.sales ?? []).filter((sale: any) => !sale.productId)
    if (needsLink.length) {
      const byName = new Map((snap.products ?? []).map((p: any) => [p.name, p.id]))
      const patched = needsLink
        .filter((sale: any) => byName.has(sale.productName))
        .map((sale: any) => ({ ...sale, productId: byName.get(sale.productName) }))
      if (patched.length) {
        try {
          await storeApi.batch('sales', patched, [])
          snap = await storeApi.snapshot()
          console.info(`[store] linked ${patched.length} existing sale(s) to their product`)
        } catch (err) {
          console.error('[store] could not backfill sale productId', err)
        }
      }
    }
    adoptAll(snap)
    setReady(true)
    syncQueue.markHealthy()
  }, [adoptAll])

  useEffect(() => { void load() }, [load])
  useEffect(() => syncQueue.subscribe((s) => { if (ready) setStatus(s) }), [ready])

  const setBranch = useCallback((b: string) => {
    setBranchState(b)
    syncQueue.push(() => storeApi.setSetting('branch', b))
  }, [])

  const setProfileName = useCallback((v: string) => {
    setProfileNameState(v)
    syncQueue.push(() => storeApi.setSetting('profileName', v))
  }, [])

  const setAddress = useCallback((v: string) => {
    setAddressState(v)
    syncQueue.push(() => storeApi.setSetting('address', v))
  }, [])

  const replaceAll = useCallback(async (snapshot: Partial<Snapshot>) => {
    // A save still waiting in the queue must not land after the replace and
    // quietly write old records back over a restore, an import or a reset.
    if (!(await syncQueue.whenIdle())) throw new Error('Some recent changes are still being saved. Wait until the badge at the top says "Saved", then try again.')
    await storeApi.replaceAll(snapshot)
    const fresh = await storeApi.snapshot()
    adoptAll(fresh)
  }, [adoptAll])

  const exportSnapshot = useCallback((): Snapshot => ({
    products, purchases, sales, customers, suppliers, expenses,
    settings: { branch, profileName, address },
  }), [products, purchases, sales, customers, suppliers, expenses, branch, profileName, address])

  // Warn before closing with unsaved writes still in the queue.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (syncQueue.hasPending) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return {
    ready, loadError, status, reload: load,
    products, setProducts, purchases, setPurchases, sales, setSales,
    customers, setCustomers, suppliers, setSuppliers, expenses, setExpenses,
    branch, setBranch, profileName, setProfileName, address, setAddress, replaceAll, exportSnapshot,
  }
}
