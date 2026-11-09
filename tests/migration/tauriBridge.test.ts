import { afterEach, expect, it } from 'vitest'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseCipher } from '../fixtures/databaseCipher'
import { BridgeCoordinator } from '../../migration/electron/bridgeCoordinator'
import { authenticateRelease, type MigrationRelease } from '../../migration/electron/bridgeRelease'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keyId = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const keys = [{ id: keyId, publicKey }]
function signed(release: MigrationRelease) {
 const body = JSON.stringify(release)
 return { body, keyId, signature: sign(null, Buffer.from('Tia launcher framework migration v1\0' + body), pair.privateKey).toString('base64') }
}
async function fixture(osProtected = false) {
 const profile = await mkdtemp(join(tmpdir(), 'tia-bridge-')); directories.push(profile)
 const key = Buffer.alloc(32, 17)
 const envelope = { version: 1, mode: osProtected ? 'os' : 'file', data: osProtected ? Buffer.from('wrapped-test-key').toString('base64') : key.toString('hex'), migrated: true, tag: '' }
 envelope.tag = createHmac('sha256', key).update(JSON.stringify([1, envelope.mode, envelope.data, true])).digest('hex')
 await writeFile(join(profile, 'launcher.key'), JSON.stringify(envelope))
 const db = new DatabaseSync(join(profile, 'launcher.db'))
 db.exec('CREATE TABLE records(scope TEXT,name TEXT,value TEXT,PRIMARY KEY(scope,name)); PRAGMA user_version=2;')
 db.prepare('INSERT INTO records VALUES(?,?,?)').run('launcher', 'settings', new DatabaseCipher(key).seal('launcher', 'settings', JSON.stringify({ lang: 'na_id', fpsLimit: 144 })))
 db.close()
 const installer = join(profile, 'update.exe'); await writeFile(installer, 'signed-installer-fixture')
 const helper = resolve(`src-tauri/target/debug/tia-migration-helper${process.platform === 'win32' ? '.exe' : ''}`)
 const release: MigrationRelease = { protocol: 1, appId: 'com.serenetia.tia-launcher', bridgeVersion: '1.99.0', targetVersion: '2.0.0', platform: 'windows-x64', installerSha512: createHash('sha512').update(await readFile(installer)).digest('base64'), helperSha256: createHash('sha256').update(await readFile(helper)).digest('hex') }
 return { profile, key, installer, helper, release }
}

it('binds a signed migration to the bridge, target, app identity and payload hashes', async () => {
 const { release } = await fixture()
 const proof = signed(release)
 expect(authenticateRelease(proof, keys, release.appId, '1.99.0', '2.0.0')).toEqual(release)
 expect(() => authenticateRelease({ ...proof, body: proof.body.replace('2.0.0', '3.0.0') }, keys, release.appId, '1.99.0', '2.0.0')).toThrow(/signature/)
 expect(() => authenticateRelease(proof, [], release.appId, '1.99.0', '2.0.0')).toThrow(/unrecognized/)
 for (const [app, bridge, target] of [['other.app', '1.99.0', '2.0.0'], [release.appId, '1.98.0', '2.0.0'], [release.appId, '1.99.0', '2.0.1']]) {
  expect(() => authenticateRelease(proof, keys, app, bridge, target)).toThrow(/does not match/)
 }
})

it('migrates before installing, keeps custom per-user scope, and combines double clicks', async () => {
 const data = await fixture(); const original = await readFile(join(data.profile, 'launcher.db'))
 let installed = 0, acquired = 0, released = 0
 const coordinator = new BridgeCoordinator()
 const dependencies = { ...data, appId: data.release.appId, bridgeVersion: '1.99.0', targetVersion: '2.0.0', keys, signedRelease: signed(data.release), storage: { decryptString: () => '' },
  acquireOperation: () => { acquired++; return () => { released++ } },
  installation: async () => ({ directory: 'D:\\My Games\\Tia Launcher', scope: 'currentUser' as const }),
  install: async (context: { directory: string; scope: string }) => {
   expect(context).toEqual({ directory: 'D:\\My Games\\Tia Launcher', scope: 'currentUser' })
   expect(JSON.parse(await readFile(join(data.profile, 'launcher.tauri.key'), 'utf8')).version).toBe(1)
   expect(await readFile(join(data.profile, 'launcher.db'))).toEqual(original)
   installed++
  }
 }
 await Promise.all([coordinator.install(dependencies), coordinator.install(dependencies)])
 expect({ installed, acquired, released }).toEqual({ installed: 1, acquired: 1, released: 1 })
}, 30_000)

it('never starts an installer if its bytes change during the handoff', async () => {
 const data = await fixture(true); let installed = false, released = false
 await expect(new BridgeCoordinator().install({ ...data, appId: data.release.appId, bridgeVersion: '1.99.0', targetVersion: '2.0.0', keys, signedRelease: signed(data.release),
  storage: { decryptString: () => { writeFileSync(data.installer, 'changed'); return data.key.toString('hex') } },
  acquireOperation: () => () => { released = true },
  installation: async () => ({ directory: 'D:\\Tia Launcher', scope: 'allUsers' }),
  install: () => { installed = true }
 })).rejects.toThrow(/has changed/)
 expect(installed).toBe(false); expect(released).toBe(true)
}, 30_000)
