import { fixtureProof } from '../fixtures/manifestSigning'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DatabaseCipher } from '../../src/main/databaseCipher'
import { configureDatabaseDirectory, databasePath, gameScope, protectDatabase, readRecord, writeRecords, moveGameRecords } from '../../src/main/localDatabase'
import { initializeDatabaseProtection, type KeyStorage } from '../../src/main/databaseProtection'
import { verifyAgainstManifest } from '../../src/main/manifestVerify'
import { verificationReference } from '../../src/main/verificationReference'

vi.mock('../../src/shared/manifestKeys.json', async () => ({ default: [(await import('../fixtures/manifestSigning')).fixtureKey] }))
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: {} }))
vi.mock('../../src/main/logger', () => ({ logInfo: vi.fn() }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tia-protected-')); roots.push(root)
  configureDatabaseDirectory(root)
  return root
}
const fileStorage: KeyStorage = { available: () => false, encrypt: () => { throw Error('unavailable') }, decrypt: () => { throw Error('unavailable') } }
const wrapping = new DatabaseCipher(randomBytes(32))
const osStorage: KeyStorage = { available: () => true, encrypt: value => Buffer.from(wrapping.seal('key', 'key', value)), decrypt: value => wrapping.open('key', 'key', value.toString()) }
function alter(sql: string, ...params: string[]) {
  const db = new DatabaseSync(databasePath()); try { db.prepare(sql).run(...params) } finally { db.close() }
}

describe('authenticated launcher data', () => {
  it('encrypts old settings and backup, drops unauthenticated cache, preserves preferences and installed hashes', async () => {
    const root = await fixture()
    writeRecords('launcher', { settings: { language: 'id', secret: 'sensitive-example' } })
    writeRecords('game:example', { install: { version: 'old', files: [{ md5: 'sensitive-hash' }] }, verifyCache: { fake: 'stamp' } })
    await initializeDatabaseProtection(root, osStorage)
    expect(readRecord('launcher', 'settings')).toEqual({ language: 'id', secret: 'sensitive-example' })
    expect(readRecord('game:example', 'install')).toEqual({ version: 'old', files: [{ md5: 'sensitive-hash' }] })
    expect(readRecord('game:example', 'verifyCache')).toBeUndefined()
    for (const suffix of ['', '.bak']) {
      const bytes = await readFile(databasePath() + suffix)
      expect(bytes.includes(Buffer.from('sensitive-example'))).toBe(false)
      expect(bytes.includes(Buffer.from('sensitive-hash'))).toBe(false)
    }
    const key = JSON.parse(await readFile(join(root, 'launcher.key'), 'utf8'))
    expect(key.mode).toBe('os')
    expect(key.migrated).toBe(true)
    await initializeDatabaseProtection(root, osStorage)
    expect(readRecord('launcher', 'settings')).toHaveProperty('language', 'id')
  })

  it('rejects plaintext edits, ciphertext corruption, and copying a value to another record or scope', async () => {
    await fixture(); protectDatabase(randomBytes(32), true)
    writeRecords('launcher', { settings: { language: 'ja' }, preferences: {} })
    const db = new DatabaseSync(databasePath()); const raw = String(db.prepare("SELECT value FROM records WHERE name='settings'").get()!.value); db.close()
    alter('UPDATE records SET value=? WHERE name=?', raw, 'preferences')
    expect(() => readRecord('launcher', 'preferences')).toThrow(/could not be verified/)
    alter('UPDATE records SET value=? WHERE name=?', '{}', 'settings')
    expect(() => readRecord('launcher', 'settings')).toThrow(/could not be verified/)
    expect(() => writeRecords('launcher', { settings: {} })).toThrow(/could not be verified/)
    alter('UPDATE records SET value=? WHERE name=?', raw.slice(0, -8) + 'AAAAAAAA', 'settings')
    expect(() => readRecord('launcher', 'settings')).toThrow(/could not be verified/)
    alter('INSERT INTO records(scope,name,value) VALUES(?,?,?)', 'another', 'settings', raw)
    expect(() => readRecord('another', 'settings')).toThrow(/could not be verified/)
  })

  it('does not silently recreate a missing key or migrate an edited database back to plaintext', async () => {
    const root = await fixture(); writeRecords('launcher', { settings: { language: 'ko' } })
    await initializeDatabaseProtection(root, osStorage)
    await rm(join(root, 'launcher.key'))
    await expect(initializeDatabaseProtection(root, osStorage)).rejects.toThrow(/could not be verified/)
    await expect(stat(join(root, 'launcher.key'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('rejects an edited migration flag instead of accepting a plaintext downgrade', async () => {
    const root = await fixture(); await initializeDatabaseProtection(root, osStorage)
    const path = join(root, 'launcher.key')
    const saved = JSON.parse(await readFile(path, 'utf8')); saved.migrated = false
    await writeFile(path, JSON.stringify(saved))
    await expect(initializeDatabaseProtection(root, osStorage)).rejects.toThrow(/could not be verified/)
  })

  it('does not rewrite the database or reopen the OS key store during warm verification', async () => {
    const root = await fixture(); const game = join(root, 'game'); await mkdir(game)
    const decrypt = vi.fn(osStorage.decrypt)
    await initializeDatabaseProtection(root, { ...osStorage, decrypt })
    await writeFile(join(game, 'asset'), 'good')
    const manifest = { version: 'v1', files: [{ path: 'asset', md5: createHash('md5').update('good').digest('hex'), size: 4 }] }
    await verifyAgainstManifest(game, manifest, true)
    const before = await readFile(databasePath())
    await verifyAgainstManifest(game, manifest, true)
    await verifyAgainstManifest(game, manifest, true)
    expect(await readFile(databasePath())).toEqual(before)
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('preserves the key when the OS credential store cannot decrypt it', async () => {
    const root = await fixture(); await initializeDatabaseProtection(root, osStorage)
    const before = await readFile(join(root, 'launcher.key'), 'utf8')
    await expect(initializeDatabaseProtection(root, fileStorage)).rejects.toThrow(/could not be verified/)
    expect(await readFile(join(root, 'launcher.key'), 'utf8')).toBe(before)
  })

  it('supports Linux without a keyring and upgrades the same key when a keyring becomes available', async () => {
    const root = await fixture(); await initializeDatabaseProtection(root, fileStorage)
    writeRecords('launcher', { settings: { language: 'zh' } })
    expect(JSON.parse(await readFile(join(root, 'launcher.key'), 'utf8')).mode).toBe('file')
    if (process.platform !== 'win32') expect((await stat(join(root, 'launcher.key'))).mode & 0o777).toBe(0o600)
    await initializeDatabaseProtection(root, osStorage)
    expect(JSON.parse(await readFile(join(root, 'launcher.key'), 'utf8')).mode).toBe('os')
    expect(readRecord('launcher', 'settings')).toHaveProperty('language', 'zh')
  })

  it('reauthenticates game records under a new directory when moving an installation', async () => {
    const root = await fixture(); await initializeDatabaseProtection(root, osStorage)
    const source = join(root, 'old'), destination = join(root, 'new')
    writeRecords(gameScope(source), { install: { installDir: source }, trustedManifest: { version: 'v1', files: [] } })
    writeRecords('launcher', { preferences: { confirmedInstallDir: source }, selectedInstallation: { installDir: source } })
    moveGameRecords(source, destination, { installDir: destination })
    expect(readRecord(gameScope(destination), 'trustedManifest')).toEqual({ version: 'v1', files: [] })
    expect(readRecord('launcher', 'preferences')).toEqual({ confirmedInstallDir: destination })
    expect(readRecord('launcher', 'selectedInstallation')).toEqual({ installDir: destination })
    expect(readRecord(gameScope(source), 'install')).toBeUndefined()
  })

  it('ignores a forged cache and rebuilds it from file contents, then performs zero content reads on warm Play', async () => {
    const root = await fixture(); const game = join(root, 'game'); await mkdir(game)
    await initializeDatabaseProtection(root, osStorage)
    await writeFile(join(game, 'asset'), 'good')
    const manifest = { version: 'v1', files: [{ path: 'asset', md5: createHash('md5').update('good').digest('hex'), size: 4 }] }
    await verifyAgainstManifest(game, manifest, true)
    alter('UPDATE records SET value=? WHERE name=?', JSON.stringify({ asset: 'forged' }), 'verifyCache')
    const samples: { hashedFiles: number; cacheHits: number }[] = []
    await verifyAgainstManifest(game, manifest, true, { onMetrics: m => samples.push(m) })
    await verifyAgainstManifest(game, manifest, true, { onMetrics: m => samples.push(m) })
    expect(samples[0]).toHaveProperty('hashedFiles', 1)
    expect(samples[1]).toMatchObject({ hashedFiles: 0, cacheHits: 1 })
  })

  it('requires a server baseline once and uses its protected copy offline instead of editable imported hashes', async () => {
    const root = await fixture(); await initializeDatabaseProtection(root, osStorage)
    const state = { version: 'v1', installDir: root, files: [] }
    expect(() => verificationReference(root, state, null)).toThrow(/internet once/)
    const body = { version: 'v1', files: [{ path: 'asset', size: 4, md5: 'a'.repeat(32) }] }
    const remote = { ...body, proof: fixtureProof(body) }
    expect(verificationReference(root, state, remote)).toEqual(remote)
    expect(verificationReference(root, state, null)).toEqual(body)
    expect(() => verificationReference(root, { ...state, version: 'v2' }, null)).toThrow(/internet once/)
  })
})
