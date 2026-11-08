const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tracked = new Set()
let tracking = false
function cleanupSync() {
  for (const directory of tracked) {
    try { fs.rmSync(directory, { recursive: true, force: true }) } catch {}
  }
  tracked.clear()
}
process.once('exit', cleanupSync)
module.exports = {
  track(enabled = true) { tracking = enabled; return this },
  mkdir(prefix, callback) {
    if (typeof prefix !== 'string' || !prefix || prefix === '.' || prefix === '..' || /[\\/\0]/.test(prefix)) {
      process.nextTick(callback, new Error('Invalid temporary directory prefix'))
      return
    }
    fs.mkdtemp(path.join(os.tmpdir(), prefix + '-'), (error, directory) => {
      if (!error && tracking) tracked.add(directory)
      callback(error, directory)
    })
  },
  cleanupSync
}
