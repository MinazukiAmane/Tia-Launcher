import { app, dialog, ipcMain, shell } from 'electron'
import { fetchLauncherInfo } from './launcherApi'
import { readInstallState } from './installState'
import { readSettings, writeSettings, type Settings } from './settings'
import { getCachedNews, type NewsItem } from './news'
import {
  performInstallOrUpdate,
  launchGame,
  checkDirWritable,
  setApprovedInstallDir,
  isApprovedInstallDir,
  type ProgressUpdate
} from './gameManager'

export async function handlePing(): Promise<string> {
  return 'pong'
}

export async function handleGetLauncherInfo(): Promise<unknown> {
  return fetchLauncherInfo('https://sg-csore-api.serenetia.com', 'csore_global')
}

export async function handleGetInstallState(_event: unknown, installDir: string) {
  return readInstallState(installDir)
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
  return writeSettings(app.getPath('userData'), settings)
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
): (_event: unknown, installDir: string) => Promise<void> {
  return async (_event: unknown, installDir: string): Promise<void> => {
    await assertApprovedInstallDir(installDir)
    return performInstallOrUpdate(installDir, (update: ProgressUpdate) => {
      if (!win.isDestroyed()) win.webContents.send('game:progress', update)
    })
  }
}

const ALLOWED_EXTERNAL_HOSTS = new Set(['cso-rse.my.id'])

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
  ipcMain.handle('app:getUserDataDir', () => app.getPath('userData'))

  ipcMain.handle('app:getPlatform', () => process.platform)
  ipcMain.handle('window:minimize', () => win.minimize())
  ipcMain.handle('window:close', () => win.close())
}
