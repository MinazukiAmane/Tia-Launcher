import { BrowserWindow, screen, type Rectangle } from 'electron'

import { launchOverlayArtwork } from './launchOverlayArtwork'

export const launchOverlayHTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:236px;height:100px}</style>
</head><body>${launchOverlayArtwork}</body></html>`

export class LaunchOverlay {
  private window: BrowserWindow | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private shownAt = 0

  show(bounds?: Rectangle): void {
    this.close()
    const { workArea } = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
    const win = new BrowserWindow({
      width: 236, height: 100,
      x: Math.max(workArea.x, workArea.x + workArea.width - 260),
      y: Math.max(workArea.y, workArea.y + workArea.height - 124),
      frame: false, transparent: true, backgroundColor: '#00000000',
      show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    })
    this.window = win
    this.shownAt = Date.now()
    win.setIgnoreMouseEvents(true)
    win.setMenu(null)
    win.once('ready-to-show', () => { if (this.window === win && !win.isDestroyed()) win.showInactive() })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(launchOverlayHTML)).catch(() => {
      if (this.window === win) this.close()
    })
    this.timer = setTimeout(() => this.close(), 30_000)
  }

  gameDetected(): void {
    if (!this.window) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.close(), Math.max(0, 3000 - (Date.now() - this.shownAt)))
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed()) win.destroy()
  }
}
