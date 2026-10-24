const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron')
const http = require('http')
const path = require('path')
const net = require('net')
const fs = require('fs')

let mainWindow = null

// Preferred size. This is a *ceiling*, not a fixed size: the window is
// always clamped to the display's usable work area so it can never open
// larger than the screen (the old code hardcoded 1536x864, which hangs
// off the edge of a 1366x768 laptop).
const BASE_WIDTH = 1536
const BASE_HEIGHT = 864

// The narrowest the layout actually works at. The old minWidth of 320
// let the user drag the window into a size no stylesheet handled.
const MIN_WIDTH = 1024
const MIN_HEIGHT = 640

// Preferred port. If something else already holds it (another app, or a
// backend left behind by a crash) we pick a free one instead of silently
// talking to whatever is listening there. The renderer learns the real
// port through the preload script.
const PREFERRED_PORT = 3001
let SERVER_PORT = PREFERRED_PORT

function findFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => {
      // Preferred port busy: let the OS hand us any free one.
      const any = net.createServer()
      any.listen(0, '127.0.0.1', () => {
        const port = any.address().port
        any.close(() => resolve(port))
      })
    })
    srv.listen(preferred, '127.0.0.1', () => srv.close(() => resolve(preferred)))
  })
}

function getWindowBounds() {
  const { workArea } = screen.getPrimaryDisplay()
  // Leave a small margin so the window never sits flush against the
  // taskbar, and never exceed what the display can actually show.
  const width = Math.min(BASE_WIDTH, workArea.width - 40)
  const height = Math.min(BASE_HEIGHT, workArea.height - 40)
  return {
    width: Math.max(width, Math.min(MIN_WIDTH, workArea.width)),
    height: Math.max(height, Math.min(MIN_HEIGHT, workArea.height)),
    // Centre inside the work area rather than the raw screen, so the
    // titlebar is not hidden behind the taskbar.
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
  }
}

// Zoom is applied as Chromium's zoom factor on the page, not by resizing
// the window. Resizing the window (the old behaviour) made the app smaller
// without making the text any more readable, which was the opposite of
// what the button implies.
ipcMain.handle('window:set-zoom', (_event, scale) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const s = Number(scale)
  if (!Number.isFinite(s)) return
  mainWindow.webContents.setZoomFactor(Math.min(2, Math.max(0.5, s)))
})

// ---------------------------------------------------------------------
// Automatic backups, with a copy in iCloud Drive on a Mac.
//
// The whole shop lives in one SQLite file. The shell asks the backend to
// flush its write-ahead log, then copies that file into <userData>/Backups
// with a dated name:
//   - a minute after the app opens,
//   - every hour while it is open, but only if something changed,
//   - when the window is closed (macOS) and when the app quits,
//   - when "Back up now" is pressed, and just before a restore.
//
// On a Mac with iCloud Drive turned on, every backup is also copied to
// iCloud Drive/Mame Backups. iCloud Drive is an ordinary folder that macOS
// uploads by itself, so no Apple login or API is involved. The LIVE database
// never goes there: iCloud syncing a database while it is being written can
// damage it. Only finished copies do, and each one is fully written in a
// private folder first and then moved in with a single rename, so iCloud
// never sees half a file.
//
// Kept (in both places): the newest 48 copies, plus the newest copy of each
// day for the last 60 days. Everything else is deleted.
// ---------------------------------------------------------------------
const os = require('os')
const { spawnSync } = require('child_process')

const RECENT_KEEP = 48
const DAILY_DAYS = 60
const CLOUD_FOLDER_NAME = 'Mame Backups'
// Test hooks (never set in normal use).
const HOURLY_MS = Number(process.env.MAME_BACKUP_INTERVAL_MS) || 60 * 60 * 1000
const STARTUP_DELAY_MS = Number(process.env.MAME_BACKUP_STARTUP_DELAY_MS) || 60 * 1000

const BACKUP_RE = /^mame-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(-[a-z-]+)?\.db$/
const STUB_RE = /^\.(mame-backup-.+\.db)\.icloud$/ // iCloud placeholder for a file not downloaded to this Mac

function dbFilePath() {
  return path.join(app.getPath('userData'), 'mame_shop.db')
}
function backupDir() {
  const dir = path.join(app.getPath('userData'), 'Backups')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function privateTempDir(name) {
  const dir = path.join(app.getPath('userData'), name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
function backupTime(name) {
  const m = BACKUP_RE.exec(name)
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null
}

/** iCloud Drive's folder on this Mac, or null (not a Mac, or iCloud Drive off). */
function cloudRoot() {
  if (!process.env.MAME_ICLOUD_DIR && process.platform !== 'darwin') return null
  const root = process.env.MAME_ICLOUD_DIR // tests: a stand-in folder
    || path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  try { return fs.statSync(root).isDirectory() ? root : null } catch { return null }
}
const cloudSupported = () => Boolean(process.env.MAME_ICLOUD_DIR) || process.platform === 'darwin'
const cloudDirPath = () => { const root = cloudRoot(); return root ? path.join(root, CLOUD_FOLDER_NAME) : null }

// Last iCloud result, kept on disk so Settings can show it after a restart.
const cloudStatusFile = () => path.join(app.getPath('userData'), 'icloud-backup.json')
function readCloudStatus() {
  try { return JSON.parse(fs.readFileSync(cloudStatusFile(), 'utf8')) } catch { return {} }
}
function writeCloudStatus(patch) {
  const next = { ...readCloudStatus(), ...patch }
  try { fs.writeFileSync(cloudStatusFile(), JSON.stringify(next, null, 2)) } catch { /* status is informational */ }
  return next
}
function errorKind(err) {
  const code = err && err.code
  if (code === 'EPERM' || code === 'EACCES') return 'permission'
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'full'
  if (code === 'ENOENT') return 'missing'
  return 'other'
}

/** Which backups to keep: newest 48, plus the newest of each day for 60 days. */
function backupsToKeep(names, now = Date.now()) {
  const sorted = [...new Set(names)].filter((n) => backupTime(n)).sort().reverse()
  const keep = new Set(sorted.slice(0, RECENT_KEEP))
  // "Before restore" copies are the undo for a restore, import or reset:
  // keep them for 30 days no matter how many backups come after.
  for (const name of sorted) {
    if (name.includes('-before-restore') && now - backupTime(name).getTime() <= 30 * 24 * 60 * 60 * 1000) keep.add(name)
  }
  const seenDay = new Set()
  for (const name of sorted) {
    const t = backupTime(name)
    if (now - t.getTime() > DAILY_DAYS * 24 * 60 * 60 * 1000) continue
    const day = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}` // local calendar day
    if (!seenDay.has(day)) { seenDay.add(day); keep.add(name) }
  }
  return keep
}

/** Delete old backups in a folder (real files and iCloud placeholders). */
function pruneFolder(dir) {
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return }
  const realName = (entry) => (BACKUP_RE.test(entry) ? entry : (STUB_RE.exec(entry) || [])[1])
  const names = entries.map(realName).filter(Boolean)
  const keep = backupsToKeep(names)
  for (const entry of entries) {
    const name = realName(entry)
    if (name && !keep.has(name)) {
      try { fs.rmSync(path.join(dir, entry), { force: true }) } catch (err) { console.warn('[Backup] could not delete old', entry, err.message) }
    }
  }
}

/** Copy one finished backup into iCloud Drive. Never throws. */
function copyToCloud(localFile) {
  const now = new Date().toISOString()
  if (!cloudSupported()) return { ok: false, kind: 'unsupported' }
  const dir = cloudDirPath()
  if (!dir) {
    writeCloudStatus({ lastAttemptAt: now, lastError: 'iCloud Drive is turned off on this Mac.', lastErrorKind: 'off' })
    return { ok: false, kind: 'off' }
  }
  const name = path.basename(localFile)
  const dest = path.join(dir, name)
  const staged = path.join(privateTempDir('icloud-staging'), `${name}.part`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(localFile, staged)
    try {
      // Same disk: an atomic move, so iCloud only ever sees the whole file.
      fs.renameSync(staged, dest)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      const partial = path.join(dir, `.${name}.part`)
      fs.copyFileSync(staged, partial)
      fs.renameSync(partial, dest)
      fs.rmSync(staged, { force: true })
    }
    if (fs.statSync(dest).size !== fs.statSync(localFile).size) throw Object.assign(new Error('The copy in iCloud Drive is incomplete.'), { code: 'EINCOMPLETE' })
    pruneFolder(dir)
    writeCloudStatus({ lastAttemptAt: now, lastCopiedAt: now, lastFile: name, lastError: null, lastErrorKind: null, folder: dir })
    console.log(`[iCloud] copied ${name}`)
    return { ok: true, path: dest }
  } catch (err) {
    try { fs.rmSync(staged, { force: true }) } catch { /* nothing staged */ }
    const kind = errorKind(err)
    // Plain words for the shop owner; the technical detail goes to the log.
    const message = kind === 'permission'
      ? 'macOS did not allow the app to use iCloud Drive.'
      : kind === 'full' ? 'There is no space left to save the copy.'
        : 'The copy could not be saved in iCloud Drive. Check that iCloud Drive is working in Finder, then press Back up now.'
    writeCloudStatus({ lastAttemptAt: now, lastError: message, lastErrorKind: kind, folder: dir })
    console.error('[iCloud] copy failed:', err)
    return { ok: false, kind, message }
  }
}

function requestCheckpoint() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: SERVER_PORT, path: '/api/checkpoint', method: 'POST', timeout: 5000 },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)) },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

let lastBackupAt = 0
let lastBackupChanges = null
const MIN_BACKUP_INTERVAL_MS = 5 * 60 * 1000
const changeCount = () => { try { return serverModule && serverModule.changeCount ? serverModule.changeCount() : null } catch { return null } }

// Backups run one at a time: an hourly one and a "Back up now" landing
// together must not both copy the same file at once.
let backupChain = Promise.resolve()
function runBackup(reason = 'scheduled', options = {}) {
  const job = backupChain.then(() => doBackup(reason, options))
  backupChain = job.catch(() => {})
  return job
}

async function doBackup(reason, { onlyIfChanged = false } = {}) {
  // Only the macOS window-close backup is rate limited; a real shutdown
  // backup captures the most recent data and must never be skipped.
  if (reason === 'window-closed' && Date.now() - lastBackupAt < MIN_BACKUP_INTERVAL_MS) {
    console.log(`[Backup] ${reason}: skipped, one was written less than 5 minutes ago`)
    return { ok: true, skipped: true }
  }
  const changes = changeCount()
  if (onlyIfChanged && changes !== null && changes === lastBackupChanges) {
    console.log(`[Backup] ${reason}: skipped, nothing changed since the last backup`)
    return { ok: true, skipped: true }
  }
  const src = dbFilePath()
  if (!fs.existsSync(src)) return { ok: false, message: 'Database file not found yet' }
  await requestCheckpoint()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const suffix = reason === 'before-restore' ? '-before-restore' : ''
  const name = `mame-backup-${stamp}${suffix}.db`
  const dest = path.join(backupDir(), name)
  try {
    fs.copyFileSync(src, dest)
    pruneFolder(backupDir())
    lastBackupAt = Date.now()
    lastBackupChanges = changes
    console.log(`[Backup] ${reason}: wrote ${dest}`)
  } catch (err) {
    console.error('[Backup] failed:', err)
    return { ok: false, message: err.message }
  }
  const cloud = copyToCloud(dest)
  return { ok: true, path: dest, name, cloud }
}

/** Every backup this Mac can see: in the local folder, in iCloud, or both. */
function listAllBackups() {
  const found = new Map()
  const add = (name, where, file, placeholder = false) => {
    const t = backupTime(name)
    if (!t) return
    const row = found.get(name) || { name, time: t.toISOString(), size: 0, local: false, cloud: false, cloudPlaceholder: false, beforeRestore: name.includes('-before-restore') }
    row[where] = true
    if (placeholder) row.cloudPlaceholder = true
    if (file && !row.size) { try { row.size = fs.statSync(file).size } catch { /* size unknown */ } }
    found.set(name, row)
  }
  for (const entry of safeReaddir(backupDir())) if (BACKUP_RE.test(entry)) add(entry, 'local', path.join(backupDir(), entry))
  const cdir = cloudDirPath()
  if (cdir) {
    for (const entry of safeReaddir(cdir)) {
      if (BACKUP_RE.test(entry)) add(entry, 'cloud', path.join(cdir, entry))
      else { const m = STUB_RE.exec(entry); if (m) add(m[1], 'cloud', null, true) }
    }
  }
  return [...found.values()].sort((a, b) => b.name.localeCompare(a.name))
}
function safeReaddir(dir) { try { return fs.readdirSync(dir) } catch { return [] } }

/**
 * Open a backup for restoring: find it (this Mac first, then iCloud),
 * download it from iCloud if only a placeholder is here, copy it to a
 * private temp folder and read it there. The live database is not touched;
 * the app replaces its data only after the user confirms.
 */
async function readBackup(name) {
  if (!BACKUP_RE.test(String(name))) return { ok: false, message: 'Unknown backup.' }
  const local = path.join(backupDir(), name)
  const cdir = cloudDirPath()
  let source = fs.existsSync(local) ? local : null
  if (!source && cdir) {
    const inCloud = path.join(cdir, name)
    if (!fs.existsSync(inCloud) && fs.existsSync(path.join(cdir, `.${name}.icloud`))) {
      // Only a placeholder is on this Mac: ask iCloud to download it.
      if (process.platform === 'darwin') spawnSync('brctl', ['download', inCloud], { timeout: 10000 })
      const until = Date.now() + 90 * 1000
      while (!fs.existsSync(inCloud) && Date.now() < until) await new Promise((r) => setTimeout(r, 1000))
    }
    if (fs.existsSync(inCloud)) source = inCloud
  }
  if (!source) return { ok: false, message: 'That backup is still downloading from iCloud. Check your internet connection and try again in a minute.' }
  const tmp = path.join(privateTempDir('restore-tmp'), name)
  try {
    fs.copyFileSync(source, tmp)
    const { snapshot, counts } = serverModule.readBackupFile(tmp)
    return { ok: true, name, time: backupTime(name).toISOString(), from: source === local ? 'local' : 'cloud', counts, snapshot }
  } catch (err) {
    console.error('[Restore] could not read', name, err)
    return { ok: false, message: err.message }
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { fs.rmSync(f, { force: true }) } catch { /* temp */ } }
  }
}

function cloudStatus() {
  const status = readCloudStatus()
  const dir = cloudDirPath()
  return {
    supported: cloudSupported(),
    available: Boolean(dir),
    folder: dir,
    copies: dir ? safeReaddir(dir).filter((e) => BACKUP_RE.test(e) || STUB_RE.test(e)).length : 0,
    lastCopiedAt: status.lastCopiedAt || null,
    lastFile: status.lastFile || null,
    lastAttemptAt: status.lastAttemptAt || null,
    lastError: status.lastError || null,
    lastErrorKind: status.lastErrorKind || null,
  }
}

function scheduleBackups() {
  // First backup shortly after launch (so a same-day crash still leaves
  // something), then hourly while the app is open, skipped when nothing changed.
  setTimeout(() => runBackup('startup'), STARTUP_DELAY_MS)
  setInterval(() => runBackup('hourly', { onlyIfChanged: true }), HOURLY_MS)
}

ipcMain.handle('backend:status', () => ({
  ok: Boolean(backend) && !backendError,
  port: SERVER_PORT,
  error: backendError ? (backendError.stack || String(backendError)) : null,
  logFile: logFilePath(),
}))
ipcMain.handle('backend:open-log', () => shell.showItemInFolder(logFilePath()))
// ---------------------------------------------------------------------
// PDF export. Renders the given HTML in a hidden window with Chromium's
// own PDF engine and asks where to save it. Works with no printer.
// ---------------------------------------------------------------------
ipcMain.handle('report:save-pdf', async (event, html, suggestedName) => {
  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow
  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: 'Save PDF',
    defaultPath: path.join(app.getPath('documents'), String(suggestedName || 'mame-report.pdf')),
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return { ok: false, cancelled: true }

  const worker = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  })
  // Write the document to a temp file rather than passing it as a data: URL.
  // A shop with a couple of years of history produces a report of several MB,
  // which exceeds Chromium's data: URL limit - the export silently never
  // finished. A file has no such limit.
  const tmpHtml = path.join(app.getPath('temp'), `mame-report-${Date.now()}.html`)
  try {
    fs.writeFileSync(tmpHtml, String(html), 'utf8')
    await worker.loadFile(tmpHtml)
    // Give web fonts and layout a moment to settle before rendering.
    await new Promise((r) => setTimeout(r, 300))
    const pdf = await worker.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      preferCSSPageSize: true,
    })
    fs.writeFileSync(filePath, pdf)
    console.log('[PDF] saved', filePath)
    // Open it so the user sees the result immediately.
    shell.openPath(filePath).catch(() => {})
    return { ok: true, path: filePath }
  } catch (err) {
    console.error('[PDF] failed', err)
    return { ok: false, message: err.message }
  } finally {
    if (!worker.isDestroyed()) worker.destroy()
    try { fs.rmSync(tmpHtml, { force: true }) } catch { /* temp file already gone */ }
  }
})

ipcMain.handle('backup:now', () => runBackup('manual'))
ipcMain.handle('backup:before-restore', () => runBackup('before-restore'))
ipcMain.handle('backup:list', () => listAllBackups())
ipcMain.handle('backup:read', (_event, name) => readBackup(name))
ipcMain.handle('backup:open-folder', () => shell.openPath(backupDir()))
ipcMain.handle('icloud:status', () => cloudStatus())
ipcMain.handle('icloud:open-folder', () => { const dir = cloudDirPath(); if (dir) { fs.mkdirSync(dir, { recursive: true }); return shell.openPath(dir) } })

// Wait until the backend server is accepting connections on SERVER_PORT
function waitForServer(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const attempt = () => {
      const sock = net.connect(SERVER_PORT, '127.0.0.1')
      sock.once('connect', () => {
        sock.end()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Backend server did not start in time'))
        } else {
          setTimeout(attempt, 400)
        }
      })
    }
    attempt()
  })
}

// ---------------------------------------------------------------------
// Logging. Everything the shell and backend print goes to a file in the
// user-data folder so a problem on a customer's machine can be diagnosed
// from that file alone. Newest 200 KB is kept.
// ---------------------------------------------------------------------
const LOG_MAX_BYTES = 200 * 1024
function initLogging() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'mame.log')
    let written = fs.existsSync(file) ? fs.statSync(file).size : 0

    // Synchronous appends. Log volume is tiny (a few lines per launch, one per
    // backup), and a stream would have to be ended and swapped during
    // rotation, which races with writes already in flight.
    const append = (entry) => {
      // Rotate while running, not only at launch: a shop can leave the app
      // open for months, and if something starts failing repeatedly a
      // launch-only check would let the log grow without limit.
      if (written + entry.length > LOG_MAX_BYTES) {
        try {
          fs.renameSync(file, path.join(dir, 'mame.previous.log'))
          written = 0
        } catch { /* keep appending to the current file if rotation fails */ }
      }
      fs.appendFileSync(file, entry)
      written += entry.length
    }

    const wrap = (orig, level) => (...args) => {
      orig.apply(console, args)
      try {
        const line = args
          .map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
        append(`${new Date().toISOString()} ${level} ${line}\n`)
      } catch { /* never let logging break the app */ }
    }
    console.log = wrap(console.log, 'INFO')
    console.warn = wrap(console.warn, 'WARN')
    console.error = wrap(console.error, 'ERROR')
    console.log('[Electron Main] ---- launch ----', { version: app.getVersion(), electron: process.versions.electron, platform: process.platform, arch: process.arch, packaged: app.isPackaged })
  } catch (err) {
    console.error('[Electron Main] Could not open log file', err)
  }
}

function logFilePath() {
  return path.join(app.getPath('userData'), 'logs', 'mame.log')
}

// ---------------------------------------------------------------------
// Backend. Runs INSIDE this process.
//
// Earlier versions spawned a separate bundled node.exe. On a customer's
// Windows machine that unsigned executable, launched from AppData, is
// exactly what Defender and SmartScreen like to block - silently - which
// left the app unable to reach its own database. Running the server in
// the Electron main process means there is nothing extra to block, and
// one fewer thing to go wrong. better-sqlite3 ships N-API prebuilds, so
// the same binary loads in Electron as in Node.
// ---------------------------------------------------------------------
let selfTestRan = false
let backend = null
let serverModule = null
let backendError = null

async function startBackendServer() {
  let serverScript
  if (app.isPackaged) {
    // Native modules cannot load from inside app.asar; build/ is unpacked.
    serverScript = path.join(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'), 'build', 'server.cjs')
    process.env.MAME_DB_PATH = app.getPath('userData')
  } else {
    serverScript = path.join(__dirname, '../build/server.cjs')
  }
  console.log('[Electron Main] Loading backend from', serverScript)
  try {
    if (!fs.existsSync(serverScript)) throw new Error(`Backend bundle not found at ${serverScript}`)
    const mod = require(serverScript)
    serverModule = mod
    backend = await mod.startServer(SERVER_PORT)
    SERVER_PORT = backend.port
    backendError = null
    console.log('[Electron Main] Backend ready on port', SERVER_PORT)
  } catch (err) {
    backendError = err
    console.error('[Electron Main] Backend failed to start:', err)
  }
}

function createWindow() {
  const bounds = getWindowBounds()
  const { workArea } = screen.getPrimaryDisplay()

  mainWindow = new BrowserWindow({
    ...bounds,
    // Size the *content area*, not the outer frame. Without this the
    // titlebar and borders eat into the height the layout was designed for.
    useContentSize: true,
    minWidth: Math.min(MIN_WIDTH, workArea.width),
    minHeight: Math.min(MIN_HEIGHT, workArea.height),
    show: false,
    backgroundColor: '#f1f5f9',
    title: 'Mame Inventory Management',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [`--mame-api-port=${SERVER_PORT}`],
    },
  })

  // If the display is too small to fit the preferred size, start maximised
  // rather than opening a window with its right edge off screen.
  if (workArea.width < BASE_WIDTH + 40 || workArea.height < BASE_HEIGHT + 40) {
    mainWindow.maximize()
  }

  // Avoid the white flash while the renderer boots.
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Self-test hook for automated smoke tests (never set in normal use):
  // MAME_SELFTEST=/some/dir makes the shell write a report of what it
  // actually did - display, window bounds, backend status, a screenshot -
  // and then quit.
  if (process.env.MAME_SELFTEST && !selfTestRan) {
    selfTestRan = true
    mainWindow.webContents.once('did-finish-load', async () => {
      const outDir = process.env.MAME_SELFTEST
      await new Promise((r) => setTimeout(r, 2500))
      try {
        const report = {
          isPackaged: app.isPackaged,
          display: screen.getPrimaryDisplay().workAreaSize,
          bounds: mainWindow.getBounds(),
          contentBounds: mainWindow.getContentBounds(),
          maximized: mainWindow.isMaximized(),
          zoomFactor: mainWindow.webContents.getZoomFactor(),
          serverAlive: Boolean(backend) && !backendError,
          dbPath: dbFilePath(),
          dbExists: fs.existsSync(dbFilePath()),
          bodyText: await mainWindow.webContents.executeJavaScript('document.body.innerText.slice(0,200)'),
          apiBase: await mainWindow.webContents.executeJavaScript('window.desktop && window.desktop.apiBase'),
        }
        // exercise the zoom IPC path from the renderer side
        await mainWindow.webContents.executeJavaScript('window.desktop.setZoom(1.3)')
        await new Promise((r) => setTimeout(r, 300))
        report.zoomAfterIpc = mainWindow.webContents.getZoomFactor()
        await mainWindow.webContents.executeJavaScript('window.desktop.setZoom(1)')
        const img = await mainWindow.webContents.capturePage()
        fs.writeFileSync(path.join(outDir, 'shell.png'), img.toPNG())
        if (process.env.MAME_SELFTEST_PDF) {
          const worker = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: false } })
          const html = '<html><body style="font-family:Inter,sans-serif"><h1>Mame report</h1><table border=1><tr><th>Item</th><th>ETB</th></tr><tr><td>Grundfos pump \u12e8\u12cd\u1203 \u1353\u121d\u1355</td><td>48,500.00</td></tr></table></body></html>'
          await worker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
          const pdf = await worker.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
          fs.writeFileSync(process.env.MAME_SELFTEST_PDF, pdf)
          report.pdfBytes = pdf.length
          worker.destroy()
        }
        // Lifecycle check: on macOS the app survives its window closing, so
        // the backend must still be serving afterwards and a reopened window
        // must still reach it. This is the failure the Mac log showed.
        if (process.env.MAME_SELFTEST_LIFECYCLE) {
          const ping = () => new Promise((resolve) => {
            const req = http.request(
              { host: '127.0.0.1', port: SERVER_PORT, path: '/api/health', method: 'GET', timeout: 4000 },
              (res) => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)) },
            )
            req.on('error', () => resolve(false))
            req.on('timeout', () => { req.destroy(); resolve(false) })
            req.end()
          })
          report.backendUpBeforeClose = await ping()
          const closed = mainWindow
          mainWindow = null
          closed.destroy()                       // user closes the window
          await new Promise((r) => setTimeout(r, 2500))
          report.appStillRunningAfterClose = !app.isQuitting
          report.backendUpAfterWindowClosed = await ping()
          app.emit('activate')                   // user clicks the Dock icon
          await new Promise((r) => setTimeout(r, 3000))
          report.windowReopened = BrowserWindow.getAllWindows().length > 0
          report.backendUpAfterReopen = await ping()
          if (mainWindow) {
            report.reopenedBodyText = await mainWindow.webContents
              .executeJavaScript('document.body.innerText.slice(0,120)').catch((e) => 'ERR ' + e.message)
          }
        }
        const backup = await runBackup('selftest')
        report.backup = backup
        fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
      } catch (err) {
        fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ error: String(err && err.stack || err) }))
      }
      app.quit()
    })
  }

  // Re-clamp if the user unplugs a monitor or changes resolution while
  // the app is open, which would otherwise strand the window off screen.
  const reclamp = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return
    const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea
    const b = mainWindow.getBounds()
    const w = Math.min(b.width, area.width)
    const h = Math.min(b.height, area.height)
    const x = Math.max(area.x, Math.min(b.x, area.x + area.width - w))
    const y = Math.max(area.y, Math.min(b.y, area.y + area.height - h))
    if (w !== b.width || h !== b.height || x !== b.x || y !== b.y) {
      mainWindow.setBounds({ x, y, width: w, height: h })
    }
  }
  screen.on('display-metrics-changed', reclamp)
  screen.on('display-removed', reclamp)

  if (app.isPackaged) {
    // Inside asar this resolves through Electron's asar-aware fs layer.
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
  } else {
    mainWindow.loadURL('http://localhost:5173')
  }

  // Chromium resets the zoom factor on navigation, and its default
  // zoom-limit range would otherwise let Ctrl+scroll break the layout.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  })

  mainWindow.on('closed', () => {
    screen.removeListener('display-metrics-changed', reclamp)
    screen.removeListener('display-removed', reclamp)
    mainWindow = null
  })
}

// Two copies of the app would mean two backends writing the same database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(async () => {
  initLogging()
  SERVER_PORT = await findFreePort(PREFERRED_PORT)
  if (SERVER_PORT !== PREFERRED_PORT) {
    console.warn(`[Electron Main] Port ${PREFERRED_PORT} is busy; backend will use ${SERVER_PORT}`)
  }
  await startBackendServer()
  createWindow()
  if (app.isPackaged) scheduleBackups()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    // Defensive: if anything stopped the backend while the app stayed alive,
    // bring it back before showing a window that depends on it.
    if (!backend) {
      console.warn('[Electron Main] Backend was not running on activate; restarting it')
      SERVER_PORT = await findFreePort(PREFERRED_PORT)
      await startBackendServer()
    }
    createWindow()
  })
})

// macOS keeps an application running after its last window closes - the icon
// stays in the Dock and clicking it reopens the window. So "all windows
// closed" is NOT a quit there. The old code shut the backend down at that
// moment but then deliberately did not quit, which left the app alive with a
// dead database: reopening from the Dock showed "Cannot open the shop
// database". Windows never hit this because closing the window quits.
//
// The backend now outlives the window and is only stopped by a real quit.
const APP_SURVIVES_WINDOW_CLOSE =
  process.env.MAME_FORCE_MAC_LIFECYCLE === '1' || process.platform === 'darwin'

async function stopBackend() {
  if (backend) {
    try { backend.close() } catch { /* already closed */ }
    backend = null
  }
}

app.on('window-all-closed', async () => {
  if (APP_SURVIVES_WINDOW_CLOSE) {
    // Still running, just without a window. Keep the backend up.
    if (app.isPackaged) await runBackup('window-closed')
    return
  }
  app.quit() // before-quit below does the backup and the shutdown
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  // Electron does not wait for async listeners, so hold the quit open until
  // the final backup is actually on disk, then quit for real.
  event.preventDefault()
  quitting = true
  void (async () => {
    if (app.isPackaged) await runBackup('shutdown')
    await stopBackend()
    app.quit()
  })()
})
