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
  private anchorTimer: ReturnType<typeof setInterval> | null = null
  private removeDisplayListeners: (() => void) | null = null

  show(bounds?: Rectangle): void {
    this.close()
    const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
    const { workArea } = display
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
    const anchor = (): void => {
      if (this.window !== win || win.isDestroyed()) return
      const area = (screen.getAllDisplays().find(item => item.id === display.id) ?? screen.getPrimaryDisplay()).workArea
      const target = {
        x: Math.max(area.x, area.x + area.width - 260),
        y: Math.max(area.y, area.y + area.height - 124),
        width: 236, height: 100
      }
      const current = win.getBounds()
      if (Object.entries(target).some(([key, value]) => current[key as keyof Rectangle] !== value)) win.setBounds(target, false)
    }
    screen.on('display-metrics-changed', anchor)
    screen.on('display-added', anchor)
    screen.on('display-removed', anchor)
    this.removeDisplayListeners = () => {
      screen.removeListener('display-metrics-changed', anchor)
      screen.removeListener('display-added', anchor)
      screen.removeListener('display-removed', anchor)
    }
    // Window managers and fullscreen games can reposition windows after creation.
    this.anchorTimer = setInterval(anchor, 500)
    win.once('ready-to-show', () => {
      if (this.window !== win || win.isDestroyed()) return
      anchor()
      win.showInactive()
      anchor()
    })
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
    if (this.anchorTimer) clearInterval(this.anchorTimer)
    this.anchorTimer = null
    this.removeDisplayListeners?.()
    this.removeDisplayListeners = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed()) win.destroy()
  }
}
