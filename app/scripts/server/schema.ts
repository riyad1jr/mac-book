import { db } from './sqlite-db.js'

/* ---------------------------------------------------------------
   Schema safety.

   `CREATE TABLE IF NOT EXISTS` silently keeps whatever table already
   exists under that name, even if it has completely different
   columns. The first Windows upgrade hit exactly that: the previous
   app version had left a `sessions` table without `expires_at`, and
   the backend died on its first query.

   ensureTable() checks the columns that the code actually relies on.
   If a table exists but is missing any of them, it is renamed to
   <name>_legacy_<timestamp> (never dropped - nothing is ever thrown
   away) and a fresh one is created.
   --------------------------------------------------------------- */

function columnsOf(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

function tableExists(table: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
  )
}

export function ensureTable(name: string, requiredColumns: string[], createSql: string) {
  if (tableExists(name)) {
    const have = columnsOf(name)
    const missing = requiredColumns.filter((c) => !have.has(c))
    if (missing.length === 0) return
    const legacy = `${name}_legacy_${Date.now()}`
    console.warn(
      `[Schema] Table "${name}" is missing column(s) ${missing.join(', ')} - ` +
      `renaming it to "${legacy}" and creating a fresh one`,
    )
    db.exec(`ALTER TABLE ${name} RENAME TO ${legacy}`)
  }
  db.exec(createSql)
}
