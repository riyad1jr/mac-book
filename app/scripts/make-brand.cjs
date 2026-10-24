#!/usr/bin/env node
/*
 * Produce the Avanza build from this (Mame) source tree.
 *
 *   node scripts/make-brand.cjs avanza ../avanza-app
 *
 * Both shops run the same code; only the name, colours and the on-disk
 * identifiers differ. The identifiers are NOT cosmetic: they decide where
 * the app looks for the shop's data. An Avanza install must keep reading
 *   %APPDATA%\Avanza Inventory\avanza_shop.db   (productName + db file)
 *   backups named avanza-backup-*.db, logs avanza.log
 *   localStorage keys avanza2-*                   (language, dark mode, zoom)
 * so every one of those is mapped back exactly as the Avanza build shipped.
 * The script refuses to finish if any "mame" survives in the output.
 */
const fs = require('fs')
const path = require('path')

const [brand, outArg] = process.argv.slice(2)
if (brand !== 'avanza' || !outArg) {
  console.error('usage: node scripts/make-brand.cjs avanza <output-dir>')
  process.exit(1)
}
const SRC = path.resolve(__dirname, '..')
const OUT = path.resolve(outArg)
const SKIP = new Set(['node_modules', 'dist', 'build', 'release', '.git'])
const TEXT = /\.(tsx?|cjs|mjs|js|css|html|json|nsh|md|cmd)$/

// Order matters: specific identifiers first, the generic rename last.
const REPLACE = [
  // package / installer identity (userData folder = productName)
  ['"name": "mame-inventory"', '"name": "ledgerly-inventory"'],
  ["title: 'Mame Inventory Management'", "title: 'Avanza Inventory Management (Merkato Water Equipment)'"],
  // localStorage keys the Avanza build used ("avanza2-" prefix)
  ["'mame-dark'", "'avanza2-dark'"],
  ["'mame-zoom'", "'avanza2-zoom'"],
  ["'mame-language'", "'avanza2-language'"],
  ["LEGACY_PREFIX = 'mame-'", "LEGACY_PREFIX = 'avanza2-'"],
  ["'mame-<collection>'", "'avanza2-<collection>'"],
  // restore accepts files from either shop's build
  ["['mame', 'avanza'].includes(parsed.app)", "['avanza', 'mame'].includes(parsed.app)"],
  // Avanza-only features (switched off in the Mame build)
  ['PURCHASE_BY_PIECE = false', 'PURCHASE_BY_PIECE = true'],
  ['ITEMS_STOCK_PDF = true', 'ITEMS_STOCK_PDF = false'],
  ['FIFO_COSTING = true', 'FIFO_COSTING = false'],
  // grammar
  ['a Mame', 'an Avanza'],
  ['ማሜ', 'አቫንዛ'],
  // everything else
  ['MAME', 'AVANZA'],
  ['Mame', 'Avanza'],
  ['mame', 'avanza'],
]

// Orange theme -> the blue theme the Avanza shop has always had.
const COLOURS = [
  ["PIE_COLORS = ['#ea580c', '#0d9488', '#7c3aed', '#db2777', '#16a34a']", "PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899']"],
  ['.metric-icon.blue{background:#ccfbf1;color:#0f766e}', '.metric-icon.blue{background:#dbeafe;color:#2563eb}'],
  ['stroke="#ea580c"', 'stroke="#2563eb"'],
  ['fill="#ea580c"', 'fill="#2563eb"'],
  ['#0d9488', '#d97706'],
  ['#c2410c', '#2563eb'],
  ['#9a3412', '#1d4ed8'],
  ['#ea580c', '#3b82f6'],
  ['#fb923c', '#60a5fa'],
  ['#fdba74', '#93c5fd'],
  ['#7c2d12', '#1e40af'],
  ['#431407', '#172554'],
  ['#ffedd5', '#dbeafe'],
  ['#fed7aa', '#bfdbfe'],
  ['#fff7ed', '#eff6ff'],
  ['rgba(194,65,12,', 'rgba(37,99,235,'],
]

const apply = (text, pairs) => pairs.reduce((t, [a, b]) => t.split(a).join(b), text)

function copy(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name === 'make-brand.cjs') continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) { copy(s, d); continue }
    // Notes: the change log is copied as written; Avanza has its own build notes.
    if (entry.name === 'BUILDING-avanza.md') continue
    if (entry.name === 'BUILDING.md' && src === SRC) { fs.copyFileSync(path.join(SRC, 'BUILDING-avanza.md'), d); continue }
    if (entry.name === 'CHANGES.md') { fs.copyFileSync(s, d); continue }
    if (entry.name === 'package-lock.json') {
      // only the root package name changes; leave dependency entries alone
      const lock = JSON.parse(fs.readFileSync(s, 'utf8'))
      lock.name = 'ledgerly-inventory'
      if (lock.packages && lock.packages['']) lock.packages[''].name = 'ledgerly-inventory'
      fs.writeFileSync(d, JSON.stringify(lock, null, 2) + '\n')
      continue
    }
    if (!TEXT.test(entry.name)) { fs.copyFileSync(s, d); continue }
    let text = fs.readFileSync(s, 'utf8')
    text = apply(text, REPLACE)
    if (/\.(tsx?|css|html)$/.test(entry.name)) text = apply(text, COLOURS)
    fs.writeFileSync(d, text)
  }
}

fs.rmSync(OUT, { recursive: true, force: true })
copy(SRC, OUT)
const nm = path.join(SRC, 'node_modules')
if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(OUT, 'node_modules'), 'dir')

// Nothing Mame-branded or orange may survive (the backup-accept list and
// the change log are the only places the other name is allowed).
const leftovers = []
;(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) { scan(p); continue }
    if (!TEXT.test(entry.name) || entry.name === 'CHANGES.md' || entry.name === 'BUILDING.md' || entry.name === 'package-lock.json') continue
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      const clean = line.replace("['avanza', 'mame']", '')
      if (/mame|ማሜ/i.test(clean) || /#(c2410c|ea580c|9a3412|0d9488)/i.test(clean)) leftovers.push(`${path.relative(OUT, p)}:${i + 1}: ${line.trim().slice(0, 100)}`)
    })
  }
})(OUT)
if (leftovers.length) {
  console.error('Mame leftovers in the Avanza tree:\n' + leftovers.join('\n'))
  process.exit(2)
}
console.log(`Avanza tree written to ${OUT}`)
