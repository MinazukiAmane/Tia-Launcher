import { contextBridge, ipcRenderer } from 'electron'
import { IPC_UPDATE } from '../../src/shared/updateChannels'
import type { UpdateState } from '../../src/shared/launcherApiTypes'

contextBridge.exposeInMainWorld('bridge', {
  state: (): Promise<UpdateState> => ipcRenderer.invoke(IPC_UPDATE.GET_STATE),
  check: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATE.CHECK),
  download: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATE.START_DOWNLOAD, true),
  install: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATE.QUIT_AND_INSTALL),
  onChange: (callback: () => void): (() => void) => {
    const channels = [IPC_UPDATE.STATE, IPC_UPDATE.AVAILABLE, IPC_UPDATE.DOWNLOAD_PROGRESS, IPC_UPDATE.DOWNLOADED, IPC_UPDATE.NOT_AVAILABLE, IPC_UPDATE.ERROR]
    const listener = (): void => callback()
    for (const channel of channels) ipcRenderer.on(channel, listener)
    return () => { for (const channel of channels) ipcRenderer.removeListener(channel, listener) }
  }
})
