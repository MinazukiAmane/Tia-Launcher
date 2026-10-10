import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers, registerGameIpcHandlers, handleOpenExternal } from './ipc'
import { initAutoUpdater } from './updater'
import { startNewsPolling } from './news'
import { readSettings, getCachedWindowCloseBehavior, setCachedWindowCloseBehavior } from './settings'
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
    if (getCachedWindowCloseBehavior() !== 'minimize_to_tray') return // default case: unchanged, untouched close.
    event.preventDefault()
    win.hide()
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

let mainWindow: BrowserWindow | null = null

function trayIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.png')
  return join(__dirname, '../../build/icon.png')
}

function createTray(): Tray {
  const icon = nativeImage.createFromPath(trayIconPath())
  const trayIcon = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }))
  trayIcon.setToolTip('CSORE Launcher')

  const showWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.show()
    mainWindow.focus()
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

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    registerIpcHandlers()
    mainWindow = createMainWindow()
    registerGameIpcHandlers(mainWindow)
    initAutoUpdater(mainWindow)
    startNewsPolling(mainWindow)
    tray = createTray()

    try {
      const settings = await readSettings(app.getPath('userData'))
      setTroubleshootingMode(settings.troubleshootingMode)
      setCachedWindowCloseBehavior(settings.windowCloseBehavior)
    } catch {
      // Defaults (false / 'exit') are already what each module starts with.
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
      } else {
        mainWindow?.show()
      }
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
