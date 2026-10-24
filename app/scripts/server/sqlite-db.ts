import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

// The database lives wherever the desktop shell tells us (the user's
// AppData folder when packaged), or the project root in development.
const dbDir = process.env.MAME_DB_PATH
  ? path.resolve(process.env.MAME_DB_PATH)
  : path.resolve(process.cwd())
fs.mkdirSync(dbDir, { recursive: true })
export const dbPath = path.join(dbDir, 'mame_shop.db')
console.log(`[SQLite] Opening database at: ${dbPath}`)

export const db = new Database(dbPath)

db.pragma('foreign_keys = ON')
// WAL gives fast, crash-safe writes. The shell asks for a checkpoint before
// copying the file so backups are always a single complete .db.
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

// Note: earlier versions created and seeded relational tables (products,
// sales, ...) here that the UI never actually read from or wrote to. They
// are intentionally no longer created. Existing databases that still have
// them are unaffected - the live data lives in the `records` table.
