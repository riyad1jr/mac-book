const fs = require('fs')
const path = require('path')
const { build } = require('electron-builder')

const logPath = path.join(__dirname, '..', 'bg-dist.log')

function log(msg) {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`)
}

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

log('Starting dist build (nsis + portable)')

build({
  win: ['nsis', 'portable'],
  config: {
    appId: 'com.mame.inventory',
    productName: 'Mame Inventory',
    asar: false,
    npmRebuild: false,
    directories: {
      output: path.join(__dirname, '../tmp-release'),
    },
    files: [
      'dist/**/*',
      'electron/**/*',
      'build/**/*',
      'package.json',
      '!node_modules/**/*',
    ],
    win: {
      target: ['nsis', 'portable'],
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      include: path.join(__dirname, 'installer.nsh'),
    },
  },
})
  .then(() => {
    log('BUILD SUCCESS')
  })
  .catch((err) => {
    log('BUILD ERROR: ' + (err && err.stack ? err.stack : String(err)))
    process.exit(1)
  })