import { contextBridge, ipcRenderer } from 'electron'

import { IPC_UPDATE } from '../main/updater'

const gameApi = {
  getLauncherInfo: (): Promise<import('../main/launcherApi').GamePackageEntry> =>
    ipcRenderer.invoke('game:getLauncherInfo'),

  getInstallState: (installDir: string): Promise<import('../main/ipc').InstallStateResponse | null> =>
    ipcRenderer.invoke('game:getInstallState', installDir),
  getSelectedInstallDir: (): Promise<string | null> => ipcRenderer.invoke('game:getSelectedInstallDir'),
  chooseInstallFolder: (): Promise<string | null> => ipcRenderer.invoke('game:chooseInstallFolder'),
  moveInstallation: (installDir: string): Promise<import('../main/moveInstallation').MoveResult | null> =>
    ipcRenderer.invoke('game:moveInstallation', installDir),
  onMoveProgress: (callback: (progress: import('../main/moveInstallation').MoveProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: import('../main/moveInstallation').MoveProgress): void => callback(progress)
    ipcRenderer.on('game:moveProgress', listener)
    return () => ipcRenderer.removeListener('game:moveProgress', listener)
  },

  getSettings: (): Promise<import('../main/settings').Settings> => ipcRenderer.invoke('game:getSettings'),
  chooseBackground: (): Promise<string | null> => ipcRenderer.invoke('launcher:chooseBackground'),
  clearBackground: (): Promise<void> => ipcRenderer.invoke('launcher:clearBackground'),
  uninstallLauncher: (removeData: boolean): Promise<{ started: boolean; message: string }> =>
    ipcRenderer.invoke('launcher:uninstall', removeData),
  getBackground: (): Promise<string | null> => ipcRenderer.invoke('launcher:getBackground'),
  setSettings: (settings: import('../main/settings').Settings): Promise<void> =>
    ipcRenderer.invoke('game:setSettings', settings),
  launchGame: (installDir: string): Promise<import('../main/ipc').LaunchGameResult> =>
    ipcRenderer.invoke('game:launch', installDir),

  startInstallOrUpdate: (installDir: string): Promise<import('../main/gameManager').InstallOperationResult> =>
    ipcRenderer.invoke('game:startInstallOrUpdate', installDir),

  pauseInstallOrUpdate: (): Promise<void> => ipcRenderer.invoke('game:pauseInstallOrUpdate'),
  verifyInstall: (installDir: string): Promise<import('../main/gameManager').VerifyResult> =>
    ipcRenderer.invoke('game:verifyInstall', installDir),
  // See startInstallOrUpdate's comment above -- same typed result shape.
  repairInstall: (installDir: string): Promise<import('../main/gameManager').InstallOperationResult> =>
    ipcRenderer.invoke('game:repairInstall', installDir),
  uninstall: (installDir: string): Promise<void> => ipcRenderer.invoke('game:uninstall', installDir),
  getDWProtonStatus: (): Promise<import('../main/gameManager').DWProtonStatus> =>
    ipcRenderer.invoke('game:getDWProtonStatus'),
  redownloadDWProton: (): Promise<void> => ipcRenderer.invoke('game:redownloadDWProton'),
  getSikarugirStatus: (): Promise<import('../main/gameManager').SikarugirStatus> =>
    ipcRenderer.invoke('game:getSikarugirStatus'),
  chooseSikarugirWrapper: (): Promise<import('../main/gameManager').SikarugirStatus | null> =>
    ipcRenderer.invoke('game:chooseSikarugirWrapper'),
  // Client log actions.
  getLogFilePath: (): Promise<string> => ipcRenderer.invoke('game:getLogFilePath'),
  showLogFileInFolder: (): Promise<void> => ipcRenderer.invoke('game:showLogFileInFolder'),

  showInstallDirInFolder: (installDir: string): Promise<void> =>
    ipcRenderer.invoke('game:showInstallDirInFolder', installDir),

  clearDownloadCache: (installDir: string): Promise<void> =>
    ipcRenderer.invoke('game:clearDownloadCache', installDir),
  onProgress: (callback: (update: import('../main/gameManager').ProgressUpdate) => void): (() => void) => {
    const listener = (_event: unknown, update: import('../main/gameManager').ProgressUpdate): void => callback(update)
    ipcRenderer.on('game:progress', listener)
    return () => ipcRenderer.removeListener('game:progress', listener)
  },
  onNews: (callback: (items: import('../main/news').NewsItem[]) => void): (() => void) => {
    const listener = (_event: unknown, items: import('../main/news').NewsItem[]): void => callback(items)
    ipcRenderer.on('news:update', listener)
    return () => ipcRenderer.removeListener('news:update', listener)
  },
  getNews: (): Promise<import('../main/news').NewsItem[]> => ipcRenderer.invoke('news:get'),
  openExternal: (url: string): void => ipcRenderer.send('shell:open-external', url),
  getUserDataDir: (): Promise<string> => ipcRenderer.invoke('app:getUserDataDir'),
  getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('app:getPlatform'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close')
}

const updateApi = {
  onUpdateAvailable: (
    callback: (info: import('../main/updater').UpdateAvailableInfo) => void
  ): (() => void) => {
    const listener = (_event: unknown, info: import('../main/updater').UpdateAvailableInfo): void => callback(info)
    ipcRenderer.on(IPC_UPDATE.AVAILABLE, listener)
    return () => ipcRenderer.removeListener(IPC_UPDATE.AVAILABLE, listener)
  },
  onDownloadProgress: (callback: (progress: import('../main/updater').UpdateDownloadProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: import('../main/updater').UpdateDownloadProgress): void => callback(progress)
    ipcRenderer.on(IPC_UPDATE.DOWNLOAD_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC_UPDATE.DOWNLOAD_PROGRESS, listener)
  },
  onUpdateDownloaded: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC_UPDATE.DOWNLOADED, listener)
    return () => ipcRenderer.removeListener(IPC_UPDATE.DOWNLOADED, listener)
  },
  onUpdateNotAvailable: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC_UPDATE.NOT_AVAILABLE, listener)
    return () => ipcRenderer.removeListener(IPC_UPDATE.NOT_AVAILABLE, listener)
  },
  onUpdateError: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: unknown, message: string): void => callback(message)
    ipcRenderer.on(IPC_UPDATE.ERROR, listener)
    return () => ipcRenderer.removeListener(IPC_UPDATE.ERROR, listener)
  },
  checkForUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATE.CHECK),
  startUpdateDownload: (fullDownload = false): Promise<void> => ipcRenderer.invoke(IPC_UPDATE.START_DOWNLOAD, fullDownload),
  quitAndInstallUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATE.QUIT_AND_INSTALL),
  getUpdateState: (): Promise<import('../main/updater').UpdateState> => ipcRenderer.invoke(IPC_UPDATE.GET_STATE)
}

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  ...gameApi,
  ...updateApi
}

export type CsoreAPI = typeof api

contextBridge.exposeInMainWorld('csore', api)
