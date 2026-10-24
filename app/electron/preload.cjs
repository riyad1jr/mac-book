const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  // Where the local backend lives. The renderer runs from file:// when
  // packaged, so it cannot use a relative /api URL.
  apiBase: (() => {
    const arg = process.argv.find((a) => a.startsWith('--mame-api-port='))
    const port = arg ? Number(arg.split('=')[1]) : 3001
    return `http://127.0.0.1:${Number.isFinite(port) ? port : 3001}`
  })(),
  setZoom: (scale) => ipcRenderer.invoke('window:set-zoom', scale),
  backendStatus: () => ipcRenderer.invoke('backend:status'),
  openLog: () => ipcRenderer.invoke('backend:open-log'),
  savePdf: (html, suggestedName) => ipcRenderer.invoke('report:save-pdf', html, suggestedName),
  backupNow: () => ipcRenderer.invoke('backup:now'),
  backupBeforeRestore: () => ipcRenderer.invoke('backup:before-restore'),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  readBackup: (name) => ipcRenderer.invoke('backup:read', name),
  openBackupFolder: () => ipcRenderer.invoke('backup:open-folder'),
  icloudStatus: () => ipcRenderer.invoke('icloud:status'),
  openIcloudFolder: () => ipcRenderer.invoke('icloud:open-folder'),
})
