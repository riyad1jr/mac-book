import express from 'express'
import Database from 'better-sqlite3'
import cors from 'cors'
import { db } from './sqlite-db.js'
import { initStore, registerStoreRoutes, listCollection, allSettings, COLLECTIONS } from './store.js'

initStore()

const app = express()

// This server exists only to be talked to by the desktop shell on the same
// machine. It binds to loopback (see listen() below) and only answers the
// dev-server origin and the packaged file:// origin.
app.use(cors({
  origin: (origin, cb) => {
    // Electron's file:// pages send no Origin header; the Vite dev server does.
    if (!origin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return cb(null, true)
    cb(new Error('Origin not allowed'))
  },
}))
// A restore sends the whole shop in one request; years of sales can pass 25 MB.
app.use(express.json({ limit: '200mb' }))

// Lets the shell, the renderer and any diagnosis tell the difference between
// "backend still starting" and "backend is gone".
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))

/* The account system (scripts/server/auth.ts) is intentionally not wired up.
   Sign-in was removed: this is a single-shop offline till application, the
   backend listens on 127.0.0.1 only, and anyone who can open the app can
   already open the database file - so a login added friction for shop staff
   without adding real protection. auth.ts is kept, unused, so multi-user
   support can be switched on later without rewriting it. */

// --- DATA STORE ---
// No authentication: this backend listens on 127.0.0.1 only and serves the
// single desktop app running on the same machine. Whoever can open the app
// can already open the database file, so a sign-in added friction for shop
// staff without adding real protection. Windows user accounts are the right
// tool if a shop needs to keep staff out.
registerStoreRoutes(app)

// --- BACKUP ---
// Dumps the live data store. The previous version dumped a separate set of
// relational tables the UI never wrote to, so the "backup" it produced did
// not contain the shop's actual records.
app.get('/api/backup', (_req, res) => {
  try {
    const payload: Record<string, unknown> = {
      app: 'mame',
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: allSettings(),
    }
    for (const c of COLLECTIONS) payload[c] = listCollection(c)
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename=mame-backup-${new Date().toISOString().slice(0, 10)}.json`)
    res.json(payload)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
})

// Flush SQLite's write-ahead log into the main file so the .db is a
// complete, copyable single file. Called by the shell before it takes
// its daily file-level backup.
app.post('/api/checkpoint', (_req, res) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
})

/**
 * How many writes this process has made to the database. The shell compares
 * it between hourly backups and skips the backup (and the iCloud copy) when
 * nothing changed, so an idle shop does not fill iCloud with identical files.
 */
export function changeCount(): number {
  return (db.prepare('SELECT total_changes() AS c').get() as { c: number }).c
}

/**
 * Read a backup .db file (a copy the shell has already placed in a private
 * temp folder) and return its contents in the same shape the app imports.
 * Opened on its own connection; the live database is never touched here.
 */
export function readBackupFile(file: string) {
  const src = new Database(file, { fileMustExist: true })
  try {
    const check = src.pragma('quick_check', { simple: true })
    if (check !== 'ok') throw new Error('This backup file is damaged and cannot be restored.')
    const hasTable = (name: string) =>
      !!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    if (!hasTable('records')) throw new Error('This file is not a shop backup.')
    const snapshot: Record<string, unknown> = {}
    for (const c of COLLECTIONS) snapshot[c] = []
    const rows = src.prepare('SELECT collection, body FROM records ORDER BY rowid').all() as { collection: string; body: string }[]
    for (const row of rows) {
      if (!(COLLECTIONS as readonly string[]).includes(row.collection)) continue
      ;(snapshot[row.collection] as unknown[]).push(JSON.parse(row.body))
    }
    const settings: Record<string, string> = {}
    if (hasTable('settings')) {
      for (const r of src.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) settings[r.key] = r.value
    }
    snapshot.settings = settings
    const counts: Record<string, number> = {}
    for (const c of COLLECTIONS) counts[c] = (snapshot[c] as unknown[]).length
    return { snapshot, counts }
  } finally {
    src.close()
  }
}

/**
 * Start listening. Called by the Electron shell in-process, or by the
 * standalone entry below when run directly with node.
 */
export function startServer(port: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    // Bind to the loopback interface explicitly. The default binds to 0.0.0.0,
    // which exposed the shop's entire sales and customer database to every
    // other machine on the same wifi.
    const server = app.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port
      console.log(`[Mame Backend] Running on http://127.0.0.1:${actual}`)
      resolve({ port: actual, close: () => server.close() })
    })
    server.on('error', reject)
  })
}

// Standalone mode: `node server.cjs` (development, or manual diagnosis).
if (require.main === module) {
  startServer(Number(process.env.PORT) || 3001).catch((err) => {
    console.error('[Mame Backend] Failed to start:', err)
    process.exit(1)
  })
}
