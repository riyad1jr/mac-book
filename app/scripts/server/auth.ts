import crypto from 'crypto'
import { db } from './sqlite-db.js'
import { ensureTable } from './schema.js'

/* ---------------------------------------------------------------
   Local account storage.

   Passwords are hashed with scrypt (built into Node, no native
   dependency to compile) using a per-user random salt. The previous
   implementation accepted any password and returned a fixed token
   string, so anyone who could open the app was an admin.
   --------------------------------------------------------------- */

const SCRYPT_KEYLEN = 64
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }

export function initAuth() {
  ensureTable('users', ['id', 'email', 'full_name', 'password_hash', 'password_salt', 'role', 'created_at'], `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  ensureTable('sessions', ['token', 'user_id', 'created_at', 'expires_at'], `
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
  `)
  // Drop expired sessions on every startup.
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run()
}

function hashPassword(password: string, salt?: string) {
  const useSalt = salt ?? crypto.randomBytes(16).toString('hex')
  const hash = crypto
    .scryptSync(password.normalize('NFKC'), useSalt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
    .toString('hex')
  return { hash, salt: useSalt }
}

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function countUsers(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  return row.c
}

export function createUser(fullName: string, email: string, password: string) {
  if (!email || !email.includes('@')) throw new Error('A valid email is required')
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters')
  }
  const { hash, salt } = hashPassword(password)
  const id = `u-${crypto.randomUUID()}`
  try {
    db.prepare(
      `INSERT INTO users (id, email, full_name, password_hash, password_salt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, email.trim(), fullName?.trim() || email.split('@')[0], hash, salt)
  } catch (err: any) {
    if (String(err.message).includes('UNIQUE')) {
      throw new Error('An account with that email already exists')
    }
    throw err
  }
  return { id, email: email.trim(), name: fullName?.trim() || email.split('@')[0] }
}

export function verifyUser(email: string, password: string) {
  const row = db
    .prepare('SELECT id, email, full_name, password_hash, password_salt FROM users WHERE email = ?')
    .get(String(email ?? '').trim()) as
    | { id: string; email: string; full_name: string; password_hash: string; password_salt: string }
    | undefined

  // Hash even when the user does not exist, so a missing account and a
  // wrong password take the same amount of time to answer.
  const salt = row?.password_salt ?? 'no-such-user-placeholder-salt'
  const { hash } = hashPassword(String(password ?? ''), salt)
  if (!row) return null
  if (!safeEqual(hash, row.password_hash)) return null
  return { id: row.id, email: row.email, name: row.full_name }
}

export function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const row = db
    .prepare('SELECT email FROM users WHERE id = ?')
    .get(userId) as { email: string } | undefined
  if (!row) throw new Error('Account not found')
  if (!verifyUser(row.email, currentPassword)) throw new Error('Current password is incorrect')
  if (!newPassword || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters')
  }
  const { hash, salt } = hashPassword(newPassword)
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, userId)
}

export function createSession(userId: string, days = 30) {
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`,
  ).run(token, userId, `+${days} days`)
  return token
}

export function resolveSession(token: string) {
  if (!token) return null
  return (
    (db
      .prepare(
        `SELECT u.id, u.email, u.full_name AS name
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > datetime('now')`,
      )
      .get(token) as { id: string; email: string; name: string } | undefined) ?? null
  )
}

export function destroySession(token: string) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}
