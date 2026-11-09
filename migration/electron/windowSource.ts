import type { BrowserWindow } from 'electron'

export type WindowSource = BrowserWindow | (() => BrowserWindow | null)
export function currentWindow(source: WindowSource): BrowserWindow | null {
  const win = typeof source === 'function' ? source() : source
  return win && !win.isDestroyed() ? win : null
}
