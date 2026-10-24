import type { Express } from 'express'
import { db } from './sqlite-db.js'
import { ensureTable } from './schema.js'

/* ---------------------------------------------------------------
   Document store.

   The live UI keeps its data as plain arrays of records (products,
   sales, purchases, ...) and mutates them in place. It was persisting
   those arrays to localStorage, which is Chromium's browser cache -
   capped at a few MB, wiped by cleanup tools, and not a file anyone
   can back up.

   This replaces localStorage with SQLite while keeping the exact same
   record shapes, so none of the UI's business logic has to change.
   One row per record, keyed by (collection, id), body stored as JSON.
   SQLite's json_extract() is available if reporting ever needs to
   query inside the body.
   --------------------------------------------------------------- */

export const COLLECTIONS = [
  'products', 'purchases', 'sales', 'customers', 'suppliers', 'expenses',
] as const
export type Collection = (typeof COLLECTIONS)[number]

function isCollection(name: string): name is Collection {
  return (COLLECTIONS as readonly string[]).includes(name)
}

export function initStore() {
  ensureTable('records', ['collection', 'id', 'body', 'updated_at'], `
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      body       TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (collection, id)
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS records_collection ON records(collection);`)
  ensureTable('settings', ['key', 'value', 'updated_at'], `
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `)
}

const q = {
  list: () => db.prepare('SELECT body FROM records WHERE collection = ? ORDER BY rowid'),
  upsert: () => db.prepare(`
    INSERT INTO records (collection, id, body, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(collection, id) DO UPDATE SET
      body = excluded.body, updated_at = excluded.updated_at`),
  remove: () => db.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
  clear: () => db.prepare('DELETE FROM records WHERE collection = ?'),
  count: () => db.prepare('SELECT COUNT(*) AS c FROM records'),
  getSetting: () => db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: () => db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
  allSettings: () => db.prepare('SELECT key, value FROM settings'),
}

export function listCollection(collection: Collection): unknown[] {
  return (q.list().all(collection) as { body: string }[]).map((r) => JSON.parse(r.body))
}

/** Replace a whole collection atomically (import / reset). */
export const replaceCollection = db.transaction((collection: Collection, records: { id: string }[]) => {
  q.clear().run(collection)
  const up = q.upsert()
  for (const rec of records) up.run(collection, String(rec.id), JSON.stringify(rec))
})

/** Apply a batch of upserts and deletes atomically. */
export const applyBatch = db.transaction(
  (collection: Collection, upserts: { id: string }[], deletes: string[]) => {
    const up = q.upsert()
    const rm = q.remove()
    for (const rec of upserts) up.run(collection, String(rec.id), JSON.stringify(rec))
    for (const id of deletes) rm.run(collection, String(id))
  },
)

export function isStoreEmpty(): boolean {
  return (q.count().get() as { c: number }).c === 0
}

export function getSetting(key: string): string | null {
  const row = q.getSetting().get(key) as { value: string } | undefined
  return row ? row.value : null
}
export function setSetting(key: string, value: string) {
  q.setSetting().run(key, value)
}
export function allSettings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of q.allSettings().all() as { key: string; value: string }[]) out[r.key] = r.value
  return out
}

function validRecords(body: unknown): body is { id: string }[] {
  return Array.isArray(body) && body.every((r) => r && typeof r === 'object' && 'id' in r)
}

export function registerStoreRoutes(app: Express) {
  // Snapshot of everything: used on startup and for backups.
  app.get('/api/store', (_req, res) => {
    const out: Record<string, unknown> = { settings: allSettings() }
    for (const c of COLLECTIONS) out[c] = listCollection(c)
    res.json(out)
  })

  app.get('/api/store/:collection', (req, res) => {
    const c = req.params.collection
    if (!isCollection(c)) return res.status(404).json({ message: `Unknown collection ${c}` })
    res.json(listCollection(c))
  })

  // Batched upserts + deletes: the client diffs its array and sends only
  // what changed, so a rapid burst of edits is one write transaction.
  app.post('/api/store/:collection/batch', (req, res) => {
    const c = req.params.collection
    if (!isCollection(c)) return res.status(404).json({ message: `Unknown collection ${c}` })
    const { upserts = [], deletes = [] } = req.body ?? {}
    if (!validRecords(upserts) || !Array.isArray(deletes)) {
      return res.status(400).json({ message: 'Malformed batch' })
    }
    try {
      applyBatch(c, upserts, deletes.map(String))
      res.json({ ok: true, upserts: upserts.length, deletes: deletes.length })
    } catch (err: any) {
      res.status(500).json({ message: err.message })
    }
  })

  // Replace one collection wholesale (used by import and reset).
  app.put('/api/store/:collection', (req, res) => {
    const c = req.params.collection
    if (!isCollection(c)) return res.status(404).json({ message: `Unknown collection ${c}` })
    if (!validRecords(req.body)) return res.status(400).json({ message: 'Expected an array of records with ids' })
    try {
      replaceCollection(c, req.body)
      res.json({ ok: true, count: req.body.length })
    } catch (err: any) {
      res.status(500).json({ message: err.message })
    }
  })

  // Replace everything at once, atomically. Import uses this so a half-
  // failed restore can never leave products from one backup and sales
  // from another.
  app.put('/api/store', (req, res) => {
    const body = req.body ?? {}
    for (const c of COLLECTIONS) {
      if (body[c] !== undefined && !validRecords(body[c])) {
        return res.status(400).json({ message: `Collection ${c} is malformed` })
      }
    }
    try {
      db.transaction(() => {
        for (const c of COLLECTIONS) if (body[c] !== undefined) replaceCollection(c, body[c])
        if (body.settings && typeof body.settings === 'object') {
          for (const [k, v] of Object.entries(body.settings)) setSetting(k, String(v))
        }
      })()
      res.json({ ok: true })
    } catch (err: any) {
      res.status(500).json({ message: err.message })
    }
  })

  app.get('/api/settings/:key', (req, res) => {
    const v = getSetting(req.params.key)
    res.json({ key: req.params.key, value: v })
  })
  app.put('/api/settings/:key', (req, res) => {
    const { value } = req.body ?? {}
    if (typeof value !== 'string') return res.status(400).json({ message: 'value must be a string' })
    setSetting(req.params.key, value)
    res.json({ ok: true })
  })
}
