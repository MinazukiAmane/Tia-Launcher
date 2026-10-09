import { contextBridge, ipcRenderer } from 'electron'

import { IPC_UPDATE } from '../main/updater'

const gameApi = {
  getLauncherInfo: (): Promise<import('../main/launcherApi').GamePackageEntry> =>
    ipcRenderer.invoke('game:getLauncherInfo'),
  getInstallState: (installDir: string): Promise<import('../main/installState').InstallState | null> =>
    ipcRenderer.invoke('game:getInstallState', installDir),
  chooseInstallFolder: (): Promise<string | null> => ipcRenderer.invoke('game:chooseInstallFolder'),

  getSettings: (): Promise<import('../main/settings').Settings> => ipcRenderer.invoke('game:getSettings'),
  setSettings: (settings: import('../main/settings').Settings): Promise<void> =>
    ipcRenderer.invoke('game:setSettings', settings),
  launchGame: (installDir: string): Promise<void> => ipcRenderer.invoke('game:launch', installDir),
  startInstallOrUpdate: (installDir: string): Promise<void> =>
    ipcRenderer.invoke('game:startInstallOrUpdate', installDir),
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
  onDownloadProgress: (callback: (progress: { percent: number }) => void): (() => void) => {
    const listener = (_event: unknown, progress: { percent: number }): void => callback(progress)
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
  startUpdateDownload: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATE.START_DOWNLOAD),
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
