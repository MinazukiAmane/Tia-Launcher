import { developerAccess } from './developerAccess'
import { developerHardware } from './developerHardware'
import { findGameExecutable } from './launcher/windows'
import { assertLauncherCurrent } from './launcherVersionGate'
import { importExistingInstall } from './existingInstall'
import { saveSikarugirWrapper } from './launcher/macos'
import { currentWindow, type WindowSource } from './windowSource'
import { app, dialog, ipcMain, shell } from 'electron'
import { importBackground, clearBackgrounds, readBackgroundDataUrl } from './background'
import { planLauncherUninstall, runPackageUninstaller, openWindowsUninstaller } from './launcherUninstall'
import { existsSync, promises as fsPromises } from 'fs'
import { join as pathJoin, dirname as pathDirname } from 'path'
import { rm } from 'fs/promises'
import { join } from 'path'
import { fetchLauncherInfo } from './launcherApi'
import { readInstallState, readPendingAudioPatch, type InstallState } from './installState'
import { readSettings, writeSettings, setCachedWindowCloseBehavior, type Settings } from './settings'
import { getCachedNews, type NewsItem } from './news'
import { logFilePath, setTroubleshootingMode, logError } from './logger'
import {
  performInstallOrUpdate,
  launchGame,
  checkDirWritable,
  setApprovedInstallDir,
  getSelectedInstallDir,
  isApprovedInstallDir,
  verifyInstall,
  repairInstall,
  isOperationInProgress,
  uninstallGame,
  moveInstallation,
  getDWProtonStatus,
  redownloadDWProton,
  getSikarugirStatus,
  pauseCurrentOperation,
  type ProgressUpdate,
  type VerifyResult,
  type DWProtonStatus,
  type SikarugirStatus,
  type InstallOperationResult
} from './gameManager'

export async function handlePing(): Promise<string> {
  return 'pong'
}

export async function handleGetLauncherInfo(): Promise<unknown> {
  if (await developerAccess.useBypass()) {
    const selected = await getSelectedInstallDir()
    const state = selected ? await readInstallState(selected) : null
    return { game: { id: 'developer-local', biz: 'csore_global' }, main: { major: { version: state?.version ?? '0.0.0', game_pkgs: [], res_list_url: '' }, patches: [], required_client_version: '' } }
  }
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
  if (await developerAccess.useBypass()) {
    try { await findGameExecutable(installDir) } catch { return null }
    return { ...(state ?? { version: '0.0.0', installDir, files: [] }), needsRepair: false, pendingAudioPatch: false }
  }
  if (!state) return null
  const pending = await readPendingAudioPatch(installDir)
  return { ...state, pendingAudioPatch: pending !== null }
}

export async function handleChooseInstallFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const chosen = result.filePaths[0]
  if (!(await checkDirWritable(chosen))) {
    const isWindowsProtected =
      process.platform === 'win32' && /^[A-Za-z]:\\(Program Files( \(x86\))?|Windows)(\\|$)/i.test(chosen)
    throw new Error(
      isWindowsProtected
        ? `"${chosen}" can't be used -- Windows blocks regular apps from writing inside "Program Files" or "Windows" without administrator rights. Choose a folder like "C:\\Games" instead, or a folder in your user directory.`
        : `"${chosen}" is not writable. Choose a different folder.`
    )
  }
  if (isOperationInProgress()) throw new Error('Wait for the install or repair to finish before choosing a folder.')
  if (await developerAccess.useBypass()) await findGameExecutable(chosen)
  else await importExistingInstall(chosen)
  await setApprovedInstallDir(chosen)
  return chosen
}

export async function handleChooseBackground(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const userData = app.getPath('userData')
  const name = await importBackground(userData, result.filePaths[0])
  const current = await readSettings(userData)
  await writeSettings(userData, { ...current, customBackground: name })
  return readBackgroundDataUrl(userData, name)
}

export async function handleClearBackground(): Promise<void> {
  const userData = app.getPath('userData')
  const current = await readSettings(userData)
  await writeSettings(userData, { ...current, customBackground: null })
  await clearBackgrounds(userData)
}

export interface LauncherUninstallResult {
  started: boolean
  message: string
}

export async function handleUninstallLauncher(_event: unknown, removeData: boolean): Promise<LauncherUninstallResult> {
  const uninstallerPath = pathJoin(pathDirname(process.execPath), 'Uninstall Tia Launcher.exe')
  const packageType = process.platform === 'linux'
    ? await fsPromises.readFile(pathJoin(process.resourcesPath, 'package-type'), 'utf8').then(value => value.trim()).catch(() => undefined)
    : undefined
  const plan = planLauncherUninstall({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appImagePath: process.env.APPIMAGE,
    packageType,
    uninstallerExists: existsSync(uninstallerPath)
  })
  const userData = app.getPath('userData')
  const wipeData = async (): Promise<void> => {
    if (removeData) await fsPromises.rm(userData, { recursive: true, force: true })
  }

  switch (plan.kind) {
    case 'unavailable':
    case 'manual':
      return { started: false, message: plan.message }
    case 'trash_app':
      await shell.trashItem(plan.appPath)
      await wipeData()
      app.quit()
      return { started: true, message: 'Launcher moved to Trash.' }
    case 'delete_appimage': {
      await fsPromises.rm(plan.appImagePath, { force: true })
      await wipeData()
      app.quit()
      return { started: true, message: 'Launcher removed.' }
    }
    case 'package_manager': {
      if (isOperationInProgress()) throw new Error('Wait for the game operation to finish before uninstalling the launcher.')
      await runPackageUninstaller(plan.command, plan.args)
      await wipeData()
      app.quit()
      return { started: true, message: 'Launcher removed.' }
    }
    case 'run_uninstaller': {
      await openWindowsUninstaller(plan.uninstallerPath, path => shell.openPath(path))
      await wipeData()
      app.quit()
      return { started: true, message: 'Uninstaller started.' }
    }
  }
}

export async function handleGetBackground(): Promise<string | null> {
  const userData = app.getPath('userData')
  const current = await readSettings(userData)
  return readBackgroundDataUrl(userData, current.customBackground)
}

export async function handleGetNews(): Promise<NewsItem[]> {
  return getCachedNews()
}

export async function handleGetSettings(): Promise<Settings> {
  return readSettings(app.getPath('userData'))
}

export async function handleSetSettings(_event: unknown, incoming: Settings): Promise<void> {
  const userData = app.getPath('userData')
  // Only background handlers may change customBackground.
  const current = await readSettings(userData)
  const settings: Settings = { ...incoming, customBackground: current.customBackground }
  await writeSettings(userData, settings)

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

export interface LaunchGameResult {
  launched: boolean

  verifyResult?: VerifyResult
}

// Play checks changed assets; the manual integrity action always hashes all files.
export async function handleLaunchGame(_event: unknown, installDir: string): Promise<LaunchGameResult> {
  await assertApprovedInstallDir(installDir)
  if (isOperationInProgress()) throw new Error('Wait for the install or repair to finish before playing.')
  if (await developerAccess.useBypass()) {
    await launchGame(installDir)
    return { launched: true }
  }
  const verifyResult = await verifyInstall(installDir, true)
  if (!verifyResult.ok) {
    logError('handleLaunchGame: verification failed, refusing to launch', {
      installDir,
      corruptFiles: verifyResult.corruptFiles.length,
      missingFiles: verifyResult.missingFiles.length
    })
    return { launched: false, verifyResult }
  }
  await launchGame(installDir)
  return { launched: true }
}

export function makeHandleStartInstallOrUpdate(
  win: WindowSource
): (_event: unknown, installDir: string) => Promise<InstallOperationResult> {
  let pending: { installDir: string; result: Promise<InstallOperationResult> } | null = null
  return async (_event: unknown, installDir: string): Promise<InstallOperationResult> => {
    await assertApprovedInstallDir(installDir)
    if (pending) {
      if (pending.installDir === installDir) return pending.result
      throw new Error('Wait for the current installation to finish before updating another folder.')
    }
    const result = performInstallOrUpdate(installDir, (update: ProgressUpdate) => {
      currentWindow(win)?.webContents.send('game:progress', update)
    }).finally(() => { pending = null })
    pending = { installDir, result }
    return result
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
  win: WindowSource
): (_event: unknown, installDir: string) => Promise<InstallOperationResult> {
  return async (_event: unknown, installDir: string): Promise<InstallOperationResult> => {
    await assertApprovedInstallDir(installDir)
    return repairInstall(installDir, (update: ProgressUpdate) => {
      currentWindow(win)?.webContents.send('game:progress', update)
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
  win: WindowSource
): () => Promise<void> {
  return async (): Promise<void> => {
    return redownloadDWProton((update: ProgressUpdate) => {
      currentWindow(win)?.webContents.send('game:progress', update)
    })
  }
}

export async function handleChooseSikarugirWrapper(): Promise<SikarugirStatus | null> {
  if (process.platform !== 'darwin') throw new Error('Sikarugir wrappers are only used on macOS.')
  const result = await dialog.showOpenDialog({
    title: 'Select the game wrapper created with Sikarugir',
    properties: ['openFile'], filters: [{ name: 'Sikarugir wrapper', extensions: ['app'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  await saveSikarugirWrapper(app.getPath('userData'), result.filePaths[0])
  return getSikarugirStatus()
}

export async function handleGetSikarugirStatus(): Promise<SikarugirStatus> {
  return getSikarugirStatus()
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
  return ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname) ||
    (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && /^\/Sikarugir-App\/Sikarugir\/?$/.test(parsed.pathname))
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

export async function handleClearDownloadCache(_event: unknown, installDir: string): Promise<void> {
  await assertApprovedInstallDir(installDir)
  await rm(join(installDir, '.csore_download_tmp'), { recursive: true, force: true })
}

export function registerIpcHandlers(): void {
  ipcMain.handle('ping', handlePing)
  ipcMain.on('shell:open-external', (_event, url: string) => handleOpenExternal(url))
}

export function makeHandleMoveInstallation(win: WindowSource, isGameBusy: () => boolean) {
  return async (_event: unknown, installDir: string) => {
    await assertApprovedInstallDir(installDir)
    if (isGameBusy()) throw new Error('Close the game before moving its installation.')
    if (isOperationInProgress()) throw new Error('Wait for the current operation to finish before moving the installation.')
    const result = await dialog.showOpenDialog({
      title: 'Move game installation — choose an empty destination folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    if (isGameBusy()) throw new Error('Close the game before moving its installation.')
    return moveInstallation(installDir, result.filePaths[0], progress => {
      currentWindow(win)?.webContents.send('game:moveProgress', progress)
    })
  }
}

export function registerGameIpcHandlers(win: WindowSource, onGameLaunched?: (installDir: string) => Promise<void> | void, isGameRunning?: () => boolean): void {
  let launching = false
  const lockedChannels = new Set([
    'game:chooseInstallFolder', 'game:moveInstallation', 'game:setSettings',
    'launcher:chooseBackground', 'launcher:clearBackground', 'game:launch',
    'game:startInstallOrUpdate', 'game:verifyInstall', 'game:repairInstall',
    'game:uninstall', 'game:redownloadDWProton', 'game:chooseSikarugirWrapper',
    'game:clearDownloadCache'
  ])
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (lockedChannels.has(channel)) assertLauncherCurrent()
      return listener(event, ...args)
    })
  }
  developerAccess.onChange = state => { currentWindow(win)?.webContents.send('developer:state', state) }
  handle('developer:getState', () => developerAccess.state())
  handle('developer:getDevice', () => developerHardware.identity())
  handle('developer:unlock', (_event, code: string) => developerAccess.unlock(code))
  handle('developer:lock', () => developerAccess.lock())
  handle('developer:setApiChecks', (_event, enabled: boolean) => {
    if (launching || isGameRunning?.() || isOperationInProgress()) throw new Error('Finish the game or current operation before changing developer settings.')
    return developerAccess.setApiChecks(enabled)
  })
  handle('news:get', handleGetNews)
  handle('game:getLauncherInfo', handleGetLauncherInfo)
  handle('game:getInstallState', handleGetInstallState)
  handle('game:getSelectedInstallDir', () => getSelectedInstallDir())
  handle('game:chooseInstallFolder', handleChooseInstallFolder)
  handle('game:moveInstallation', makeHandleMoveInstallation(win, () => launching || !!isGameRunning?.()))
  handle('game:getSettings', handleGetSettings)
  handle('game:setSettings', handleSetSettings)
  handle('launcher:chooseBackground', handleChooseBackground)
  handle('launcher:clearBackground', handleClearBackground)
  handle('launcher:getBackground', handleGetBackground)
  handle('launcher:uninstall', handleUninstallLauncher)
  handle('game:launch', async (event, installDir: string) => {
    if (launching || isGameRunning?.()) throw new Error('The game is already running or starting.')
    launching = true
    try {
      const result = await handleLaunchGame(event, installDir)
      if (result.launched) await onGameLaunched?.(installDir)
      return result
    } finally { launching = false }
  })
  handle('game:startInstallOrUpdate', makeHandleStartInstallOrUpdate(win))
  handle('game:pauseInstallOrUpdate', handlePauseInstallOrUpdate)
  handle('game:verifyInstall', handleVerifyInstall)
  handle('game:repairInstall', makeHandleRepairInstall(win))
  handle('game:uninstall', handleUninstallGame)
  handle('game:getDWProtonStatus', handleGetDWProtonStatus)
  handle('game:redownloadDWProton', makeHandleRedownloadDWProton(win))
  handle('game:getSikarugirStatus', handleGetSikarugirStatus)
  handle('game:chooseSikarugirWrapper', handleChooseSikarugirWrapper)
  handle('game:getLogFilePath', handleGetLogFilePath)
  handle('game:showLogFileInFolder', () => handleShowLogFileInFolder())
  handle('game:showInstallDirInFolder', handleShowInstallDirInFolder)
  handle('game:clearDownloadCache', handleClearDownloadCache)
  handle('app:getUserDataDir', () => app.getPath('userData'))

  handle('app:getPlatform', () => process.platform)

  handle('app:getVersion', () => app.getVersion())
  handle('window:minimize', () => currentWindow(win)?.minimize())
  handle('window:close', () => currentWindow(win)?.close())
}
