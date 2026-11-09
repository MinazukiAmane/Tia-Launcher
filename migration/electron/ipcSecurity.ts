import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { currentWindow, type WindowSource } from './windowSource'

export function assertTrustedSender(source: WindowSource, event: IpcMainEvent | IpcMainInvokeEvent): void {
  const win = currentWindow(source)
  if (!win || !event || event.sender !== win.webContents || !event.senderFrame ||
      event.senderFrame !== win.webContents.mainFrame) {
    throw new Error('IPC request is not from the active launcher window.')
  }
}
