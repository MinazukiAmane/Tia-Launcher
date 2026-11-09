import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { initAutoUpdater } from './updater'

app.setName('tia-launcher-bootstrap')
app.setPath('userData', join(app.getPath('appData'), 'tia-launcher-bootstrap'))
let window: BrowserWindow | null = null
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { window?.show(); window?.focus() })
  app.whenReady().then(async () => {
    window = new BrowserWindow({
      width: 650, height: 360, resizable: false, title: 'Tia Launcher Update',
      backgroundColor: '#18181c', show: false,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged }
    })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.once('ready-to-show', () => window?.show())
    initAutoUpdater(() => window)
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }).catch(error => { console.error(error); app.exit(1) })
  app.on('window-all-closed', () => app.quit())
}
