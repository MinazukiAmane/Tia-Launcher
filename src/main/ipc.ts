import { ipcMain } from 'electron'

export async function handlePing(): Promise<string> {
  return 'pong'
}

export function registerIpcHandlers(): void {
  ipcMain.handle('ping', handlePing)
}
