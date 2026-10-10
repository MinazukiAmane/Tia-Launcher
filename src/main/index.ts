import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers, registerGameIpcHandlers, handleOpenExternal } from './ipc'
import { initAutoUpdater } from './updater'
import { startNewsPolling } from './news'
import { readSettings } from './settings'
import { setTroubleshootingMode } from './logger'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 650,
    minWidth: 900,
    minHeight: 550,
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    handleOpenExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  win.on('close', (event) => {
    if (isQuitting) return // real Quit (tray menu or OS shutdown) -- let it close.
    event.preventDefault()
    readSettings(app.getPath('userData'))
      .then((settings) => {
        if (settings.windowCloseBehavior === 'minimize_to_tray') {
          win.hide()
        } else {
          isQuitting = true
          win.close()
        }
      })
      .catch(() => {
        isQuitting = true
        win.close()
      })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

let isQuitting = false
let tray: Tray | null = null

function createTray(win: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  const trayIcon = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }))
  trayIcon.setToolTip('CSORE Launcher')

  const showWindow = (): void => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
  }

  trayIcon.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show CSORE Launcher', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )

  trayIcon.on('double-click', showWindow)

  return trayIcon
}

app.whenReady().then(async () => {
  registerIpcHandlers()
  const win = createMainWindow()
  registerGameIpcHandlers(win)
  initAutoUpdater(win)
  startNewsPolling(win)
  tray = createTray(win)

  try {
    const settings = await readSettings(app.getPath('userData'))
    setTroubleshootingMode(settings.troubleshootingMode)
  } catch {
    // Default (false) is already what the logger module starts with.
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else win.show()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
