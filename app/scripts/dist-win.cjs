const fs = require('fs')
const path = require('path')
const { build } = require('electron-builder')

const origRename = fs.rename
const origRenameSync = fs.renameSync
const origPromisesRename = fs.promises.rename

fs.rename = function(src, dest, cb) {
  origRename(src, dest, (err) => {
    if (err && err.code === 'EPERM') {
      try { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); if (cb) cb() } catch (e) { if (cb) cb(e) }
    } else { if (cb) cb(err) }
  })
}
fs.renameSync = function(src, dest) {
  try { return origRenameSync(src, dest) } catch (err) {
    if (err.code === 'EPERM') { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); return }
    throw err
  }
}
fs.promises.rename = async function(src, dest) {
  try { return await origPromisesRename(src, dest) } catch (err) {
    if (err.code === 'EPERM') { fs.cpSync(src, dest, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); return }
    throw err
  }
}

console.log('[Electron Builder] Packaging Mame Inventory Windows installer...')

build({
  win: ['nsis', 'portable'],
  // No inline config here on purpose. The build settings live in the
  // "build" block of package.json; duplicating them here meant the two
  // could drift apart, and this copy (with asar:false) silently won.
  config: {
    directories: {
      output: path.join(__dirname, '../tmp-release'),
    },
  },
})
  .then(() => {
    console.log('[Electron Builder] Build success! Installer created in ./tmp-release/')
  })
  .catch((err) => {
    console.error('[Electron Builder Error]', err)
    process.exit(1)
  })