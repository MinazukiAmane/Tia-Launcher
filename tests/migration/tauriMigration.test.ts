import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseCipher } from '../fixtures/databaseCipher'
import { handoffDatabaseKey } from '../../migration/electron/keyHandoff'

const roots: string[] = []
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() {
 const profile = await mkdtemp(join(tmpdir(), 'tia-key-handoff-')); roots.push(profile)
 const key = Buffer.alloc(32, 21)
 const saved = { version: 1, mode: 'file', data: key.toString('hex'), migrated: true, tag: '' }
 saved.tag = createHmac('sha256', key).update(JSON.stringify([saved.version, saved.mode, saved.data, saved.migrated])).digest('hex')
 await writeFile(join(profile, 'launcher.key'), JSON.stringify(saved), { mode: 0o600 })
 const db = new DatabaseSync(join(profile, 'launcher.db'))
 db.exec('CREATE TABLE records(scope TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,name)); PRAGMA user_version=2;')
 const cipher = new DatabaseCipher(key)
 db.prepare('INSERT INTO records VALUES(?,?,?)').run('launcher', 'settings', cipher.seal('launcher', 'settings', JSON.stringify({ lang: 'na_id', launchCommand: '-test', unicode: '日本語' })))
 db.prepare('INSERT INTO records VALUES(?,?,?)').run('game:C:\\Custom\\Tia-CSORSE', 'install', cipher.seal('game:C:\\Custom\\Tia-CSORSE', 'install', JSON.stringify({ version: '0.1.54', files: [] })))
 db.close()
 const helper = resolve(`src-tauri/target/debug/tia-migration-helper${process.platform === 'win32' ? '.exe' : ''}`)
 const hash = createHash('sha256').update(await readFile(helper)).digest('hex')
 return { profile, key, helper, hash }
}

it('hands an encrypted Electron profile to Rust without replacing source database or key', async () => {
 const { profile, helper, hash } = await fixture()
 const database = await readFile(join(profile, 'launcher.db')); const key = await readFile(join(profile, 'launcher.key'))
 const receipt = await handoffDatabaseKey(profile, helper, hash, { decryptString: () => { throw new Error('not used') } })
 expect(receipt.recordsVerified).toBe(2)
 expect(receipt.databaseSha256).toBe(createHash('sha256').update(database).digest('hex'))
 expect(await readFile(join(profile, 'launcher.db'))).toEqual(database)
 expect(await readFile(join(profile, 'launcher.key'))).toEqual(key)
 expect(JSON.parse(await readFile(join(profile, 'launcher.tauri.key'), 'utf8')).version).toBe(1)
}, 30_000)

it('rejects a modified migration component before handing it key material', async () => {
 const { profile, helper } = await fixture()
 await expect(handoffDatabaseKey(profile, helper, '0'.repeat(64), { decryptString: () => '' })).rejects.toThrow(/component could not be verified/)
 await expect(readFile(join(profile, 'launcher.tauri.key'))).rejects.toHaveProperty('code', 'ENOENT')
})

it('rejects an edited Electron key envelope without modifying the old profile', async () => {
 const { profile, helper, hash } = await fixture()
 const path = join(profile, 'launcher.key'); const saved = JSON.parse(await readFile(path, 'utf8')); saved.data = '0'.repeat(64); await writeFile(path, JSON.stringify(saved))
 await expect(handoffDatabaseKey(profile, helper, hash, { decryptString: () => '' })).rejects.toThrow(/could not be verified/)
 await expect(readFile(join(profile, 'launcher.tauri.key'))).rejects.toHaveProperty('code', 'ENOENT')
})


it('recovers a legacy file-protected profile natively without passing its key', async () => {
 const { profile, helper, key } = await fixture()
 const database = await readFile(join(profile, 'launcher.db'))
 const nonce = 'a'.repeat(64)
 const receipt = await new Promise<Record<string, unknown>>((resolve, reject) => {
  const child = spawn(helper, ['--recover-profile-stdin'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.resume()
  child.on('error', reject)
  child.on('close', code => { if (code !== 0) reject(new Error('Native recovery failed')); else { try { resolve(JSON.parse(output)) } catch (error) { reject(error) } } })
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify({ protocol: 1, nonce, profile }))
 })
 expect(receipt.recordsVerified).toBe(2)
 expect(receipt.nonce).toBe(nonce)
 const digest = createHash('sha256').update(database).digest('hex')
 expect(receipt.proof).toBe(createHmac('sha256', key).update(JSON.stringify(['tia-migration-v1', nonce, digest, '2'])).digest('hex'))
 expect(await readFile(join(profile, 'launcher.db'))).toEqual(database)
}, 30_000)
