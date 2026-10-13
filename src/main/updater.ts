import { setLauncherVersionStatus, type VersionStatus } from './launcherVersionGate'
import { currentWindow, type WindowSource } from './windowSource'
import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { isOperationInProgress } from './gameManager'
import { logInfo, logError, logDebug } from './logger'

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // hourly

// Public update proxy (tia-launcher-site's /api/updates, in front of the launcher's S3 bucket).
const UPDATE_FEED_URL = 'https://tia-launcher.serenetia.com/api/updates'

export const IPC_UPDATE = {
  STATE: 'update:state',
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

export interface UpdateDownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  updatedAt: number
}

export interface UpdateState {
  versionStatus: VersionStatus
  available: UpdateAvailableInfo | null
  progress: number | null
  downloaded: boolean
  downloading: boolean
  downloadProgress: UpdateDownloadProgress | null
  error: string | null
}

export function initialUpdateState(): UpdateState {
  return { versionStatus: app.isPackaged ? 'checking' : 'current', available: null, progress: null, downloaded: false, downloading: false, downloadProgress: null, error: null }
}

export function initAutoUpdater(win: WindowSource): void {
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL })
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.logger = {
    info: (...args) => logInfo(`updater: ${args.map(String).join(' ')}`),
    warn: (...args) => logInfo(`updater warning: ${args.map(String).join(' ')}`),
    error: (...args) => logError(`updater: ${args.map(String).join(' ')}`),
    debug: (...args) => logDebug(`updater: ${args.map(String).join(' ')}`)
  }

  const state = initialUpdateState()
  setLauncherVersionStatus(state.versionStatus)
  let checkRequest: Promise<void> | null = null
  let downloadRequest: Promise<void> | null = null
  let pendingIsInitialCheck = true

  function broadcast(channel: string, ...args: unknown[]): void {
    currentWindow(win)?.webContents.send(channel, ...args)
  }

  function setVersionStatus(value: VersionStatus): void {
    state.versionStatus = value
    setLauncherVersionStatus(value)
    broadcast(IPC_UPDATE.STATE, state)
  }

  function reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (state.error === message && !state.downloading) return
    state.error = message
    state.downloading = false
    state.progress = null
    state.downloadProgress = null
    logError('updater: update failed', { error: message })
    setVersionStatus(state.available ? 'required' : 'failed')
    broadcast(IPC_UPDATE.ERROR, message)
  }

  autoUpdater.on('error', reportError)

  autoUpdater.on('update-available', (info) => {
    const payload: UpdateAvailableInfo = { version: info.version, isInitialCheck: pendingIsInitialCheck }
    if (state.available?.version !== payload.version) {
      state.progress = null
      state.downloadProgress = null
      state.downloaded = false
      state.downloading = false
    }
    state.available = payload
    state.error = null
    setVersionStatus('required')
    broadcast(IPC_UPDATE.AVAILABLE, payload)
  })

  autoUpdater.on('download-progress', (progress) => {
    const detail: UpdateDownloadProgress = {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      updatedAt: Date.now()
    }
    state.progress = progress.percent
    state.downloadProgress = detail
    state.downloading = true
    broadcast(IPC_UPDATE.DOWNLOAD_PROGRESS, detail)
  })

  autoUpdater.on('update-downloaded', () => {
    state.downloaded = true
    state.downloading = false
    state.progress = 100
    state.error = null
    broadcast(IPC_UPDATE.DOWNLOADED)
  })

  autoUpdater.on('update-not-available', () => {
    state.available = null
    state.error = null
    setVersionStatus('current')
    broadcast(IPC_UPDATE.NOT_AVAILABLE)
  })

  function checkForUpdates(): Promise<void> {
    if (downloadRequest) return Promise.resolve()
    if (checkRequest) return checkRequest
    state.error = null
    setVersionStatus(state.available ? 'required' : 'checking')
    checkRequest = Promise.resolve().then(() => autoUpdater.checkForUpdates())
      .then(result => {
        if (app.isPackaged && !result && state.versionStatus === 'checking') {
          reportError(new Error('Could not verify the latest launcher version. Please retry.'))
        }
      })
      .catch(reportError)
      .finally(() => { pendingIsInitialCheck = false; checkRequest = null })
    return checkRequest
  }

  ipcMain.handle(IPC_UPDATE.START_DOWNLOAD, (_event, fullDownload?: boolean) => {
    if (downloadRequest) return downloadRequest
    if (state.downloaded) return Promise.resolve()
    state.error = null
    state.downloading = true
    state.progress = 0
    state.downloadProgress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, updatedAt: Date.now() }
    broadcast(IPC_UPDATE.DOWNLOAD_PROGRESS, state.downloadProgress)
    const previousMode = autoUpdater.disableDifferentialDownload
    autoUpdater.disableDifferentialDownload = fullDownload === true || previousMode
    logInfo('updater: download requested', { version: state.available?.version, fullDownload: fullDownload === true })
    downloadRequest = Promise.resolve().then(() => autoUpdater.downloadUpdate())
      .then(() => undefined)
      .catch(error => { reportError(error); throw error })
      .finally(() => { autoUpdater.disableDifferentialDownload = previousMode; downloadRequest = null })
    return downloadRequest
  })

  ipcMain.handle(IPC_UPDATE.QUIT_AND_INSTALL, async () => {
    if (isOperationInProgress()) {
      throw new Error(
        'Cannot restart to install the update: a game download or patch is still in progress. Please wait for it to finish.'
      )
    }
    return autoUpdater.quitAndInstall()
  })
  ipcMain.handle(IPC_UPDATE.CHECK, () => checkForUpdates())
  ipcMain.handle(IPC_UPDATE.GET_STATE, () => state)

  // Skip in dev -- no packaged installer / update feed to check against.
  if (!app.isPackaged) return

  checkForUpdates()
  setInterval(checkForUpdates, CHECK_INTERVAL_MS)
}
