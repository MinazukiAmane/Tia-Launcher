import { contextBridge, ipcRenderer } from 'electron'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping')
}

export type CsoreAPI = typeof api

contextBridge.exposeInMainWorld('csore', api)
