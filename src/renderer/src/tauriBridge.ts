import { blocksBrowserShortcut } from '../../main/windowShortcuts'

window.addEventListener('keydown', event => {
  if (blocksBrowserShortcut({ key: event.key, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey }, import.meta.env.PROD)) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}, true)

window.addEventListener('contextmenu', event => {
  if (!(event.target instanceof HTMLElement) || !event.target.closest('input, textarea, [contenteditable="true"]')) event.preventDefault()
})

import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

window.addEventListener('tia:storage-ready', () => {
  void invoke('launcher_request', { channel: 'launcher:ready', args: [] }).catch(console.error)
})

async function playableVideo(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    const finish = (ready: boolean): void => {
      clearTimeout(timer)
      video.onloadeddata = video.onerror = null
      video.removeAttribute('src')
      video.load()
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), 12_000)
    video.onloadeddata = () => finish(video.videoWidth > 0 && video.videoHeight > 0)
    video.onerror = () => finish(false)
    video.src = convertFileSrc(path)
  })
}

type Listener = (...args: any[]) => void
const subscriptions = new Map<Listener, { canceled: boolean; stop?: UnlistenFn }>()
const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<any> {
    const value = await invoke<any>('launcher_request', { channel, args })
    if (channel === 'launcher:chooseBackgroundVideo' && value) {
      let candidate = value
      try {
        while (candidate && !candidate.committed) {
          candidate = await invoke<any>('launcher_request', { channel: 'launcher:finishBackgroundVideo', args: [candidate.token, await playableVideo(candidate.path)] })
        }
        return candidate ? convertFileSrc(candidate.path) : null
      } catch (error) {
        await invoke('launcher_request', { channel: 'launcher:discardBackgroundVideo', args: [candidate?.token] }).catch(() => {})
        throw error
      }
    }
    if (channel === 'launcher:getBackground' || channel === 'launcher:chooseBackground') return value ? convertFileSrc(value) : null
    if (channel === 'launcher:getBackgroundSources') return { image: value.image ? convertFileSrc(value.image) : null, video: value.video ? convertFileSrc(value.video) : null }
    return value
  },
  send(channel: string, ...args: unknown[]): void { void this.invoke(channel, ...args).catch(console.error) },
  on(channel: string, callback: Listener): void {
    const state = { canceled: false } as { canceled: boolean; stop?: UnlistenFn }
    subscriptions.set(callback, state)
    void listen(channel.replaceAll(':', '-'), event => callback({}, event.payload)).then(stop => { if (state.canceled) stop(); else state.stop = stop }).catch(console.error)
  },
  removeListener(_channel: string, callback: Listener): void {
    const state = subscriptions.get(callback)
    if (state) { state.canceled = true; state.stop?.(); subscriptions.delete(callback) }
  }
}

import { IPC_UPDATE } from '../../shared/updateChannels'

const gameApi = {
  getServerStatus: (): Promise<import('../../main/serverStatus').ServerStatus> => ipcRenderer.invoke('game:serverStatus'),
  getGameCatalog: (): Promise<{ games: readonly import('../../shared/gameDefinition').GameDefinition[]; selected: import('../../shared/gameDefinition').GameId }> => ipcRenderer.invoke('game:catalog'),
  selectGame: (biz: import('../../shared/gameDefinition').GameId): Promise<import('../../shared/gameDefinition').GameDefinition> => ipcRenderer.invoke('game:select', biz),
  getPreferences: (): Promise<import('../../main/preferences').Preferences> => ipcRenderer.invoke('launcher:getPreferences'),
  setPreferences: (update: Partial<import('../../main/preferences').Preferences>): Promise<import('../../main/preferences').Preferences> => ipcRenderer.invoke('launcher:setPreferences', update),
  migrateLegacyPreferences: (legacy: Partial<import('../../main/preferences').Preferences> & { installDir: string | null }): Promise<import('../../main/preferences').Preferences> => ipcRenderer.invoke('launcher:migrateLegacyPreferences', legacy),
  getLauncherInfo: (): Promise<import('../../main/launcherApi').GamePackageEntry> =>
    ipcRenderer.invoke('game:getLauncherInfo'),

  getInstallState: (installDir: string): Promise<import('../../main/ipc').InstallStateResponse | null> =>
    ipcRenderer.invoke('game:getInstallState', installDir),
  getSelectedInstallDir: (): Promise<string | null> => ipcRenderer.invoke('game:getSelectedInstallDir'),
  chooseInstallFolder: (): Promise<string | null> => ipcRenderer.invoke('game:chooseInstallFolder'),
  moveInstallation: (installDir: string): Promise<import('../../main/moveInstallation').MoveResult | null> =>
    ipcRenderer.invoke('game:moveInstallation', installDir),
  onMoveProgress: (callback: (progress: import('../../main/moveInstallation').MoveProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: import('../../main/moveInstallation').MoveProgress): void => callback(progress)
    ipcRenderer.on('game:moveProgress', listener)
    return () => ipcRenderer.removeListener('game:moveProgress', listener)
  },

  getSettings: (): Promise<import('../../main/settings').Settings> => ipcRenderer.invoke('game:getSettings'),
  chooseBackgroundVideo: (): Promise<string | null> => ipcRenderer.invoke('launcher:chooseBackgroundVideo'),
  clearBackgroundVideo: (): Promise<void> => ipcRenderer.invoke('launcher:clearBackgroundVideo'),
  chooseBackground: (): Promise<string | null> => ipcRenderer.invoke('launcher:chooseBackground'),
  clearBackground: (): Promise<void> => ipcRenderer.invoke('launcher:clearBackground'),
  uninstallLauncher: (removeData: boolean): Promise<{ started: boolean; message: string }> =>
    ipcRenderer.invoke('launcher:uninstall', removeData),
  getBackgroundSources: (): Promise<{ image: string | null; video: string | null }> => ipcRenderer.invoke('launcher:getBackgroundSources'),
  getBackground: (): Promise<string | null> => ipcRenderer.invoke('launcher:getBackground'),
  setSettings: (settings: import('../../main/settings').Settings): Promise<void> =>
    ipcRenderer.invoke('game:setSettings', settings),
  launchGame: (installDir: string): Promise<import('../../main/ipc').LaunchGameResult> =>
    ipcRenderer.invoke('game:launch', installDir),

  startInstallOrUpdate: (installDir: string): Promise<import('../../main/gameManager').InstallOperationResult> =>
    ipcRenderer.invoke('game:startInstallOrUpdate', installDir),

  pauseInstallOrUpdate: (): Promise<void> => ipcRenderer.invoke('game:pauseInstallOrUpdate'),
  verifyInstall: (installDir: string): Promise<import('../../main/gameManager').VerifyResult> =>
    ipcRenderer.invoke('game:verifyInstall', installDir),
  // See startInstallOrUpdate's comment above -- same typed result shape.
  repairInstall: (installDir: string): Promise<import('../../main/gameManager').InstallOperationResult> =>
    ipcRenderer.invoke('game:repairInstall', installDir),
  uninstall: (installDir: string): Promise<void> => ipcRenderer.invoke('game:uninstall', installDir),
  getDWProtonStatus: (): Promise<import('../../main/gameManager').DWProtonStatus> =>
    ipcRenderer.invoke('game:getDWProtonStatus'),
  redownloadDWProton: (): Promise<void> => ipcRenderer.invoke('game:redownloadDWProton'),
  getSikarugirStatus: (): Promise<import('../../main/gameManager').SikarugirStatus> =>
    ipcRenderer.invoke('game:getSikarugirStatus'),
  chooseSikarugirWrapper: (): Promise<import('../../main/gameManager').SikarugirStatus | null> =>
    ipcRenderer.invoke('game:chooseSikarugirWrapper'),
  // Client log actions.
  getLogFilePath: (): Promise<string> => ipcRenderer.invoke('game:getLogFilePath'),
  showLogFileInFolder: (): Promise<void> => ipcRenderer.invoke('game:showLogFileInFolder'),

  showInstallDirInFolder: (installDir: string): Promise<void> =>
    ipcRenderer.invoke('game:showInstallDirInFolder', installDir),

  clearDownloadCache: (installDir: string): Promise<void> =>
    ipcRenderer.invoke('game:clearDownloadCache', installDir),
  onProgress: (callback: (update: import('../../main/gameManager').ProgressUpdate) => void): (() => void) => {
    const listener = (_event: unknown, update: import('../../main/gameManager').ProgressUpdate): void => callback(update)
    ipcRenderer.on('game:progress', listener)
    return () => ipcRenderer.removeListener('game:progress', listener)
  },
  onNews: (callback: (items: import('../../main/news').NewsItem[]) => void): (() => void) => {
    const listener = (_event: unknown, items: import('../../main/news').NewsItem[]): void => callback(items)
    ipcRenderer.on('news:update', listener)
    return () => ipcRenderer.removeListener('news:update', listener)
  },
  getNews: (): Promise<import('../../main/news').NewsItem[]> => ipcRenderer.invoke('news:get'),
  getSilverIntroduction: (): Promise<{ eligible: boolean }> => ipcRenderer.invoke('launcher:getSilverIntroduction'),
  setSilverIntroductionChoice: (choice: 'interested' | 'dismissed'): Promise<void> => ipcRenderer.invoke('launcher:setSilverIntroductionChoice', choice),
  getSilverNotices: (): Promise<import('../../shared/silverNotices').SilverNoticeFeed> => ipcRenderer.invoke('silver-notices:get'),
  onSilverNotices: (callback: (feed: import('../../shared/silverNotices').SilverNoticeFeed) => void): (() => void) => {
    const listener = (_event: unknown, feed: import('../../shared/silverNotices').SilverNoticeFeed): void => callback(feed)
    ipcRenderer.on('silver-notices:update', listener)
    return () => ipcRenderer.removeListener('silver-notices:update', listener)
  },
  openExternal: (url: string): void => ipcRenderer.send('shell:open-external', url),
  getUserDataDir: (): Promise<string> => ipcRenderer.invoke('app:getUserDataDir'),
  getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('app:getPlatform'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close')
}

const updateApi = {
  onUpdateAvailable: (
    callback: (info: import('../../main/updater').UpdateAvailableInfo) => void
  ): (() => void) => {
    const listener = (_event: unknown, info: import('../../main/updater').UpdateAvailableInfo): void => callback(info)
    ipcRenderer.on(IPC_UPDATE.AVAILABLE, listener)
    return () => ipcRenderer.removeListener(IPC_UPDATE.AVAILABLE, listener)
  },
  onDownloadProgress: (callback: (progress: import('../../main/updater').UpdateDownloadProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: import('../../main/updater').UpdateDownloadProgress): void => callback(progress)
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
  onUpdateState: (callback: (state: import('../../main/updater').UpdateState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: import('../../main/updater').UpdateState): void => callback(state)
    ipcRenderer.on(IPC_UPDATE.STATE, listener)
    return () => { ipcRenderer.removeListener(IPC_UPDATE.STATE, listener) }
  },
  getUpdateState: (): Promise<import('../../main/updater').UpdateState> => ipcRenderer.invoke(IPC_UPDATE.GET_STATE)
}

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  ...gameApi,
  ...updateApi
}

export type CsoreAPI = typeof api

window.csore = api
