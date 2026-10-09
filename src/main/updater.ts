import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // hourly

const UPDATE_FEED_URL = 'https://updates.csore.example/api/updates'

export const IPC_UPDATE = {
  AVAILABLE: 'update:available',
  DOWNLOAD_PROGRESS: 'update:download-progress',
  DOWNLOADED: 'update:downloaded',
  NOT_AVAILABLE: 'update:not-available',
  ERROR: 'update:error',
  START_DOWNLOAD: 'update:start-download',
  QUIT_AND_INSTALL: 'update:quit-and-install',
  CHECK: 'update:check',
  GET_STATE: 'update:get-state'
} as const

export interface UpdateAvailableInfo {
  version: string
  isInitialCheck: boolean
}

export interface UpdateState {
  available: UpdateAvailableInfo | null
  progress: number | null
  downloaded: boolean
  error: string | null
}

export function initialUpdateState(): UpdateState {
  return { available: null, progress: null, downloaded: false, error: null }
}

export function initAutoUpdater(win: BrowserWindow): void {
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL })
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const state = initialUpdateState()
  let pendingIsInitialCheck = true

  function broadcast(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  autoUpdater.on('error', (err) => {
    state.error = err.message
    broadcast(IPC_UPDATE.ERROR, err.message)
  })

  autoUpdater.on('update-available', (info) => {
    const payload: UpdateAvailableInfo = { version: info.version, isInitialCheck: pendingIsInitialCheck }
    state.available = payload
    state.error = null
    broadcast(IPC_UPDATE.AVAILABLE, payload)
  })

  autoUpdater.on('download-progress', (progress) => {
    state.progress = progress.percent
    broadcast(IPC_UPDATE.DOWNLOAD_PROGRESS, { percent: progress.percent })
  })

  autoUpdater.on('update-downloaded', () => {
    state.downloaded = true
    broadcast(IPC_UPDATE.DOWNLOADED)
  })

  autoUpdater.on('update-not-available', () => {
    broadcast(IPC_UPDATE.NOT_AVAILABLE)
  })

  function checkForUpdates(): void {
    autoUpdater
      .checkForUpdates()
      .catch(() => {})
      .finally(() => {
        pendingIsInitialCheck = false
      })
  }

  ipcMain.handle(IPC_UPDATE.START_DOWNLOAD, () => autoUpdater.downloadUpdate())
  ipcMain.handle(IPC_UPDATE.QUIT_AND_INSTALL, () => autoUpdater.quitAndInstall())
  ipcMain.handle(IPC_UPDATE.CHECK, () => checkForUpdates())
  ipcMain.handle(IPC_UPDATE.GET_STATE, () => state)

  // Skip in dev -- no packaged installer / update feed to check against.
  if (!app.isPackaged) return

  checkForUpdates()
  setInterval(checkForUpdates, CHECK_INTERVAL_MS)
}
