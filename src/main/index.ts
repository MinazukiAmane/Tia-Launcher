import { startSilverNoticePolling } from './silverNotices'
import { selectGame } from './activeGame'
import { readRecord } from './localDatabase'
import { serveBackgroundVideo } from './backgroundMedia'
import { stopMediaConversion } from './mediaConverter'
import { configureDatabaseDirectory } from './localDatabase'
import { app, BrowserWindow, Tray, Menu, nativeImage, protocol } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers, registerGameIpcHandlers, handleOpenExternal } from './ipc'
import { initAutoUpdater } from './updater'
import { startNewsPolling } from './news'
import { readSettings, getCachedWindowCloseBehavior, setCachedWindowCloseBehavior } from './settings'
import { setTroubleshootingMode } from './logger'
import { GameSession } from './gameSession'
import { findGameExecutable } from './launcher/windows'

protocol.registerSchemesAsPrivileged([{ scheme: 'tia-background', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

app.setPath('userData', join(app.getPath('appData'), 'tia-launcher-bootstrap'))
configureDatabaseDirectory(app.getPath('userData'))
const savedGame = readRecord<string>('launcher', 'selectedGame')
if (savedGame) { try { selectGame(savedGame) } catch { /* Removed catalog entry defaults to CSO. */ } }

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 650,
    minWidth: 1100,
    maxWidth: 1100,
    minHeight: 650,
    maxHeight: 650,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Remove the native Windows sizing frame, including Aero Snap resizing.
    thickFrame: false,
    frame: false,
    backgroundColor: '#0a0a0a',

    icon: trayIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Keep user gestures and OS snap operations from changing the window size.
  win.on('will-resize', (event) => event.preventDefault())
  // Linux does not implement maximizable; handle window-manager requests too.
  win.on('maximize', () => win.unmaximize())
  win.on('enter-full-screen', () => win.setFullScreen(false))

  win.on('ready-to-show', () => { if (!isQuitting) win.show() })

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
const gameSession = new GameSession({
  suspend: () => {
    const win = mainWindow
    mainWindow = null
    // Destroying the window releases its renderer process and UI assets.
    if (win && !win.isDestroyed()) win.destroy()
  },
  restore: () => { if (!isQuitting) showMainWindow() }
})

function showMainWindow(): void {
  if (isQuitting) return
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function trayIconPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'icon.png')
  return join(__dirname, '../../build/icon.png')
}

function createTray(): Tray {
  const icon = nativeImage.createFromPath(trayIconPath())
  const trayIcon = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }))
  trayIcon.setToolTip('Tia Launcher')

  const showWindow = (): void => {
    showMainWindow()
  }

  trayIcon.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Tia Launcher', click: showWindow },
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
  trayIcon.on('click', showWindow)

  return trayIcon
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(async () => {
    protocol.handle('tia-background', request => serveBackgroundVideo(app.getPath('userData'), request))
    registerIpcHandlers()
    mainWindow = createMainWindow()
    const getWindow = (): BrowserWindow | null => mainWindow
    registerGameIpcHandlers(getWindow, async installDir => {
      try {
        const exePath = await findGameExecutable(installDir)
        if (!isQuitting) gameSession.start(exePath)
      } catch { /* Keep the launcher visible if the executable disappeared. */ }
    }, () => gameSession.active)
    initAutoUpdater(getWindow)
    startNewsPolling(getWindow)
    startSilverNoticePolling(getWindow)
    tray = createTray()

    try {
      const settings = await readSettings(app.getPath('userData'))
      setTroubleshootingMode(settings.troubleshootingMode)
      setCachedWindowCloseBehavior(settings.windowCloseBehavior)
    } catch {
      // Defaults (false / 'exit') are already what each module starts with.
    }

    app.on('activate', showMainWindow)
  })
}

app.on('before-quit', () => {
  isQuitting = true
  stopMediaConversion()
  gameSession.stop()
  tray?.destroy()
})

app.on('window-all-closed', () => {
  // Suspension clears mainWindow before destroying it.
  if (gameSession.active && mainWindow === null && !isQuitting) return
  if (process.platform !== 'darwin') app.quit()
})
