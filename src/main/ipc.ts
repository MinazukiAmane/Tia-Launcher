import { app, dialog, ipcMain, shell } from 'electron'
import { rm } from 'fs/promises'
import { join } from 'path'
import { fetchLauncherInfo } from './launcherApi'
import { readInstallState, readPendingAudioPatch, type InstallState } from './installState'
import { readSettings, writeSettings, setCachedWindowCloseBehavior, type Settings } from './settings'
import { getCachedNews, type NewsItem } from './news'
import { logFilePath, setTroubleshootingMode } from './logger'
import {
  performInstallOrUpdate,
  launchGame,
  checkDirWritable,
  setApprovedInstallDir,
  isApprovedInstallDir,
  verifyInstall,
  repairInstall,
  uninstallGame,
  getDWProtonStatus,
  redownloadDWProton,
  getWhiskyStatus,
  pauseCurrentOperation,
  type ProgressUpdate,
  type VerifyResult,
  type DWProtonStatus,
  type WhiskyStatus,
  type InstallOperationResult
} from './gameManager'

export async function handlePing(): Promise<string> {
  return 'pong'
}

export async function handleGetLauncherInfo(): Promise<unknown> {
  return fetchLauncherInfo('https://sg-csore-api.serenetia.com', 'csore_global')
}

// Persisted audio work keeps an otherwise current install in the update state.
export interface InstallStateResponse extends InstallState {
  pendingAudioPatch: boolean
}

export async function handleGetInstallState(
  _event: unknown,
  installDir: string
): Promise<InstallStateResponse | null> {
  const state = await readInstallState(installDir)
  if (!state) return null
  const pending = await readPendingAudioPatch(installDir)
  return { ...state, pendingAudioPatch: pending !== null }
}

export async function handleChooseInstallFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const chosen = result.filePaths[0]
  if (!(await checkDirWritable(chosen))) {
    throw new Error(`"${chosen}" is not writable. Choose a different folder.`)
  }
  await setApprovedInstallDir(chosen)
  return chosen
}

export async function handleGetNews(): Promise<NewsItem[]> {
  return getCachedNews()
}

export async function handleGetSettings(): Promise<Settings> {
  return readSettings(app.getPath('userData'))
}

export async function handleSetSettings(_event: unknown, settings: Settings): Promise<void> {
  await writeSettings(app.getPath('userData'), settings)

  setTroubleshootingMode(settings.troubleshootingMode)

  setCachedWindowCloseBehavior(settings.windowCloseBehavior)
}

async function assertApprovedInstallDir(installDir: string): Promise<void> {
  if (!(await isApprovedInstallDir(installDir))) {
    throw new Error(
      `"${installDir}" is not an approved install directory. Choose an install folder first.`
    )
  }
}

export async function handleLaunchGame(_event: unknown, installDir: string): Promise<void> {
  await assertApprovedInstallDir(installDir)
  return launchGame(installDir)
}

export function makeHandleStartInstallOrUpdate(
  win: Electron.BrowserWindow
): (_event: unknown, installDir: string) => Promise<InstallOperationResult> {
  return async (_event: unknown, installDir: string): Promise<InstallOperationResult> => {
    await assertApprovedInstallDir(installDir)
    return performInstallOrUpdate(installDir, (update: ProgressUpdate) => {
      if (!win.isDestroyed()) win.webContents.send('game:progress', update)
    })
  }
}

export async function handlePauseInstallOrUpdate(): Promise<void> {
  pauseCurrentOperation()
}

export async function handleVerifyInstall(_event: unknown, installDir: string): Promise<VerifyResult> {
  await assertApprovedInstallDir(installDir)
  return verifyInstall(installDir)
}

export function makeHandleRepairInstall(
  win: Electron.BrowserWindow
): (_event: unknown, installDir: string) => Promise<InstallOperationResult> {
  return async (_event: unknown, installDir: string): Promise<InstallOperationResult> => {
    await assertApprovedInstallDir(installDir)
    return repairInstall(installDir, (update: ProgressUpdate) => {
      if (!win.isDestroyed()) win.webContents.send('game:progress', update)
    })
  }
}

export async function handleUninstallGame(_event: unknown, installDir: string): Promise<void> {
  await assertApprovedInstallDir(installDir)
  return uninstallGame(installDir)
}

export async function handleGetDWProtonStatus(): Promise<DWProtonStatus> {
  return getDWProtonStatus()
}

export function makeHandleRedownloadDWProton(
  win: Electron.BrowserWindow
): () => Promise<void> {
  return async (): Promise<void> => {
    return redownloadDWProton((update: ProgressUpdate) => {
      if (!win.isDestroyed()) win.webContents.send('game:progress', update)
    })
  }
}

export async function handleGetWhiskyStatus(): Promise<WhiskyStatus> {
  return getWhiskyStatus()
}

const ALLOWED_EXTERNAL_HOSTS = new Set(['cso-rse.my.id', 'discord.gg', 'tako.id'])

export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)
}

export function handleOpenExternal(url: string, openFn: (url: string) => void = shell.openExternal): void {
  if (!isAllowedExternalUrl(url)) return
  openFn(url)
}

// Client log actions.
export async function handleGetLogFilePath(): Promise<string> {
  return logFilePath()
}

export function handleShowLogFileInFolder(
  showFn: (path: string) => void = shell.showItemInFolder
): void {
  showFn(logFilePath())
}

// Open the selected installation folder.
export async function handleShowInstallDirInFolder(
  _event: unknown,
  installDir: string,
  showFn: (path: string) => void = shell.showItemInFolder
): Promise<void> {
  await assertApprovedInstallDir(installDir)
  showFn(installDir)
}

export async function handleClearDownloadCache(): Promise<void> {
  const tempDir = app.getPath('temp')
  await Promise.all([
    rm(join(tempDir, 'csore-launcher-parts'), { recursive: true, force: true }),
    rm(join(tempDir, 'csore-launcher-download.zip'), { force: true }),
    rm(join(tempDir, 'csore-launcher-download.zip.audio.zip'), { force: true })
  ])
}

export function registerIpcHandlers(): void {
  ipcMain.handle('ping', handlePing)
  ipcMain.on('shell:open-external', (_event, url: string) => handleOpenExternal(url))
}

export function registerGameIpcHandlers(win: Electron.BrowserWindow): void {
  ipcMain.handle('news:get', handleGetNews)
  ipcMain.handle('game:getLauncherInfo', handleGetLauncherInfo)
  ipcMain.handle('game:getInstallState', handleGetInstallState)
  ipcMain.handle('game:chooseInstallFolder', handleChooseInstallFolder)
  ipcMain.handle('game:getSettings', handleGetSettings)
  ipcMain.handle('game:setSettings', handleSetSettings)
  ipcMain.handle('game:launch', handleLaunchGame)
  ipcMain.handle('game:startInstallOrUpdate', makeHandleStartInstallOrUpdate(win))
  ipcMain.handle('game:pauseInstallOrUpdate', handlePauseInstallOrUpdate)
  ipcMain.handle('game:verifyInstall', handleVerifyInstall)
  ipcMain.handle('game:repairInstall', makeHandleRepairInstall(win))
  ipcMain.handle('game:uninstall', handleUninstallGame)
  ipcMain.handle('game:getDWProtonStatus', handleGetDWProtonStatus)
  ipcMain.handle('game:redownloadDWProton', makeHandleRedownloadDWProton(win))
  ipcMain.handle('game:getWhiskyStatus', handleGetWhiskyStatus)
  ipcMain.handle('game:getLogFilePath', handleGetLogFilePath)
  ipcMain.handle('game:showLogFileInFolder', () => handleShowLogFileInFolder())
  ipcMain.handle('game:showInstallDirInFolder', handleShowInstallDirInFolder)
  ipcMain.handle('game:clearDownloadCache', handleClearDownloadCache)
  ipcMain.handle('app:getUserDataDir', () => app.getPath('userData'))

  ipcMain.handle('app:getPlatform', () => process.platform)

  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('window:minimize', () => win.minimize())
  ipcMain.handle('window:close', () => win.close())
}
