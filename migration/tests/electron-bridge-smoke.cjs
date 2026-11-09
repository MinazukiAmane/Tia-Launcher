const { app } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

app.disableHardwareAcceleration()
console.log('Starting isolated Electron bridge smoke test')

const profile = mkdtempSync(join(tmpdir(), 'tia-bridge-smoke-'))
app.setPath('appData', profile)
const timer = setTimeout(() => { console.error('Bridge smoke test timed out'); app.exit(1) }, 15000)
process.on('exit', () => { clearTimeout(timer); try { rmSync(profile, { recursive: true, force: true }) } catch (error) { console.warn('Temporary test profile cleanup:', error.message) } })
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const state = await window.bridge.state()
        return {
          bridgeOnly: !window.csore && !window.require,
          title: document.querySelector('h1').textContent,
          state: state.versionStatus,
          methods: Object.keys(window.bridge).sort()
        }
      })()`)
      if (!result.bridgeOnly || result.title !== 'Update Tia Launcher' || result.state !== 'current' || result.methods.join(',') !== 'check,download,install,onChange,state') throw new Error('Bridge isolation failed')
      console.log(JSON.stringify({ ok: true, ...result }))
      app.exit(0)
    } catch (error) { console.error(error); app.exit(1) }
  })
})
require(resolve('out/main/index.js'))
