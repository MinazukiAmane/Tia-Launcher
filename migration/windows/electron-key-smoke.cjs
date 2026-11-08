const { app, safeStorage } = require('electron')
const { DatabaseSync } = require('node:sqlite')
const { randomBytes, createCipheriv, createHmac, createHash } = require('node:crypto')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')

if (process.platform !== 'win32') throw new Error('Run this check on Windows.')
const helper = resolve(process.argv[2])
const profile = mkdtempSync(join(tmpdir(), 'tia-electron-key-'))
app.setPath('userData', profile)

app.whenReady().then(async () => {
  try {
    assert(safeStorage.isEncryptionAvailable(), 'Windows safeStorage must be available')
    const key = randomBytes(32)
    const data = safeStorage.encryptString(key.toString('hex')).toString('base64')
    const envelope = { version: 1, mode: 'os', data, migrated: true }
    envelope.tag = createHmac('sha256', key).update(JSON.stringify([1, 'os', data, true])).digest('hex')
    writeFileSync(join(profile, 'launcher.key'), JSON.stringify(envelope))
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(JSON.stringify(['launcher', 'settings'])))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ lang: 'na_id' })), cipher.final()])
    const record = 'tia:gcm:1:' + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
    const db = new DatabaseSync(join(profile, 'launcher.db'))
    db.exec('CREATE TABLE records(scope TEXT,name TEXT,value TEXT,PRIMARY KEY(scope,name)); PRAGMA user_version=2;')
    db.prepare('INSERT INTO records VALUES(?,?,?)').run('launcher', 'settings', record)
    db.close()
    // Chromium persists its DPAPI-wrapped master key when preferences are flushed.
    let savedMaster = false
    for (let attempt = 0; attempt < 200; attempt++) {
      try { savedMaster = !!JSON.parse(readFileSync(join(profile, 'Local State'), 'utf8')).os_crypt?.encrypted_key } catch {}
      if (savedMaster) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(savedMaster, 'Electron must flush its protected master key')
    const original = createHash('sha256').update(readFileSync(join(profile, 'launcher.db'))).digest('hex')
    const challenge = randomBytes(32).toString('hex')
    const receipt = await new Promise((resolve, reject) => {
      const child = spawn(helper, ['--recover-profile-stdin'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { child.kill(); reject(new Error('Migration timed out')) }, 30000)
      let output = ''
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 16384) child.kill() })
      child.stderr.resume()
      child.on('error', reject)
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Native recovery failed')) })
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify({ protocol: 1, nonce: challenge, profile }))
    })
    assert.equal(receipt.nonce, challenge)
    assert.equal(receipt.recordsVerified, 1)
    assert.equal(receipt.databaseSha256, original)
    const proof = createHmac('sha256', key).update(JSON.stringify(['tia-migration-v1', challenge, original, '1'])).digest('hex')
    assert.equal(receipt.proof, proof)
    assert.equal(createHash('sha256').update(readFileSync(join(profile, 'launcher.db'))).digest('hex'), original)
    console.log('Electron safeStorage -> native Windows recovery: PASS')
    key.fill(0)
    app.exit(0)
  } catch (error) {
    console.error(error.message)
    app.exit(1)
  }
})
app.on('quit', () => { try { rmSync(profile, { recursive: true, force: true }) } catch {} })
