const fs = require('fs')
const path = require('path')

// Copies the better-sqlite3 native module next to the bundled server so it
// can be loaded from app.asar.unpacked. The backend now runs inside the
// Electron main process, so no separate node.exe is bundled any more.
const buildDir = path.join(__dirname, '../build')
const src = path.join(__dirname, '../node_modules/better-sqlite3')
const dest = path.join(buildDir, 'node_modules/better-sqlite3')
fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })
for (const item of ['package.json', 'lib', 'prebuilds']) {
  const from = path.join(src, item)
  if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, item), { recursive: true })
}
// node-gyp-build resolution helpers the module needs at runtime
for (const dep of ['bindings', 'file-uri-to-path', 'node-gyp-build']) {
  const from = path.join(__dirname, '../node_modules', dep)
  if (fs.existsSync(from)) fs.cpSync(from, path.join(buildDir, 'node_modules', dep), { recursive: true })
}
console.log('[copy-runtime] Copied better-sqlite3 (lib + prebuilds)')
