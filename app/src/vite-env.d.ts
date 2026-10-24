/// <reference types="vite/client" />

interface BackupResult { ok: boolean; skipped?: boolean; path?: string; name?: string; message?: string; cloud?: { ok: boolean; kind?: string; message?: string } }
interface BackupEntry { name: string; time: string; size: number; local: boolean; cloud: boolean; cloudPlaceholder: boolean; beforeRestore: boolean }
interface IcloudStatus { supported: boolean; available: boolean; folder: string | null; copies: number; lastCopiedAt: string | null; lastFile: string | null; lastAttemptAt: string | null; lastError: string | null; lastErrorKind: string | null }

interface DesktopApi {
  apiBase: string
  setZoom: (scale: number) => Promise<unknown>
  backendStatus: () => Promise<{ ok: boolean; port: number; error: string | null; logFile: string }>
  openLog: () => Promise<unknown>
  savePdf: (html: string, suggestedName: string) => Promise<{ ok: boolean; path?: string; cancelled?: boolean; message?: string }>
  backupNow: () => Promise<BackupResult>
  backupBeforeRestore: () => Promise<BackupResult>
  listBackups: () => Promise<BackupEntry[]>
  readBackup: (name: string) => Promise<{ ok: boolean; message?: string; name?: string; time?: string; from?: 'local' | 'cloud'; counts?: Record<string, number>; snapshot?: Record<string, unknown> }>
  openBackupFolder: () => Promise<unknown>
  icloudStatus: () => Promise<IcloudStatus>
  openIcloudFolder: () => Promise<unknown>
}

interface Window {
  desktop?: DesktopApi
}
