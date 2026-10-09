import { dialog, ipcMain, shell } from 'electron'
import { fetchLauncherInfo } from './launcherApi'
import { readInstallState } from './installState'
import { readSettings, writeSettings, type Settings } from './settings'
import { performInstallOrUpdate, launchGame, checkDirWritable, type ProgressUpdate } from './gameManager'

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
  return chosen
}

export async function handleGetSettings(_event: unknown, userDataDir: string): Promise<Settings> {
  return readSettings(userDataDir)
}

export async function handleSetSettings(_event: unknown, userDataDir: string, settings: Settings): Promise<void> {
  return writeSettings(userDataDir, settings)
}

export function registerIpcHandlers(): void {
  ipcMain.handle('ping', handlePing)
  ipcMain.on('shell:open-external', (_event, url: string) => shell.openExternal(url))
}

export function registerGameIpcHandlers(win: Electron.BrowserWindow): void {
  ipcMain.handle('game:getLauncherInfo', handleGetLauncherInfo)
  ipcMain.handle('game:getInstallState', handleGetInstallState)
  ipcMain.handle('game:chooseInstallFolder', handleChooseInstallFolder)
  ipcMain.handle('game:getSettings', handleGetSettings)
  ipcMain.handle('game:setSettings', handleSetSettings)
  ipcMain.handle('game:launch', (_event, installDir: string) => launchGame(installDir))
  ipcMain.handle('game:startInstallOrUpdate', (_event, installDir: string) => {
    return performInstallOrUpdate(installDir, (update: ProgressUpdate) => {
      if (!win.isDestroyed()) win.webContents.send('game:progress', update)
    })
  })
}
