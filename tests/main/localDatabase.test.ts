import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureDatabaseDirectory, databasePath, gameScope, migrateRecord, readRecord, readGameRecord, writeRecords, forgetGameRecords } from '../../src/main/localDatabase'
import { readInstallState, readPendingAudioPatch, writeInstallState } from '../../src/main/installState'
import { readSettings, writeSettings } from '../../src/main/settings'
import { readPreferences, writePreferences } from '../../src/main/preferences'

async function fixture(): Promise<{ root: string; game: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tia-migration-'))
  const game = join(root, 'custom-drive', 'game')
  await mkdir(game, { recursive: true })
  configureDatabaseDirectory(root)
  return { root, game }
}

describe('central SQLite persistence', () => {
  it('migrates pre-update settings, approval, hashes, verification cache and both checkpoints without changing game files', async () => {
    const { root, game } = await fixture()
    try {
      const state = { version: '1.2.3', installDir: game, files: [{ path: 'data.bin', md5: 'old-hash' }] }
      const pending = { toVersion: '1.2.4', audioPkgs: [] }
      await writeFile(join(root, 'settings.json'), JSON.stringify({ lang: 'na_id', launchCommand: '-test' }))
      await writeFile(join(root, 'approved-install-dir.json'), JSON.stringify({ installDir: game }))
      await writeFile(join(game, 'data.bin'), 'keep these installed bytes')
      for (const [name, value] of Object.entries({ '.csore_install.json': state, '.csore_pending_audio_patch.json': pending, '.csore_fresh_game.json': { packageKey: 'package', files: state.files }, '.csore_verify_cache.json': { 'data.bin': 'stamp' } })) {
        await writeFile(join(game, name), JSON.stringify(value))
      }
      expect((await readSettings(root)).lang).toBe('na_id')
      expect(await migrateRecord('launcher', 'selectedInstallation', join(root, 'approved-install-dir.json'))).toEqual({ installDir: game })
      expect(await readInstallState(game)).toEqual(state)
      expect(await readPendingAudioPatch(game)).toEqual(pending)
      expect(readRecord(gameScope(game), 'checkpoint')).toEqual({ packageKey: 'package', files: state.files })
      expect(readRecord(gameScope(game), 'verifyCache')).toEqual({ 'data.bin': 'stamp' })
      expect(await readFile(join(game, 'data.bin'), 'utf8')).toBe('keep these installed bytes')
      expect(await readdir(game)).toContain('.csore_install.json.migrated.bak')
      expect(await readdir(game)).not.toContain('launcher.db')
      await writeInstallState(game, { ...state, version: '1.2.4' })
      await writeFile(join(game, '.csore_install.json'), JSON.stringify(state))
      expect((await readInstallState(game))?.version).toBe('1.2.4')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('recognizes archived JSON from another build and requires verification instead of a new installation', async () => {
    const { root, game } = await fixture()
    try {
      await writeFile(join(root, 'settings.json.migrated.bak'), JSON.stringify({ lang: 'na_id' }))
      await writeFile(join(game, '.csore_install.json.migrated.bak'), JSON.stringify({ version: 'installed', installDir: game, files: [] }))
      expect((await readSettings(root)).lang).toBe('na_id')
      const state = await readInstallState(game)
      expect(state?.version).toBe('installed')
      expect(state?.needsRepair).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rolls back all pending migrations when critical legacy metadata is malformed', async () => {
    const { root, game } = await fixture()
    try {
      await writeFile(join(game, '.csore_install.json'), JSON.stringify({ version: 'installed', files: [] }))
      await writeFile(join(game, '.csore_pending_audio_patch.json'), '{')
      await expect(readInstallState(game)).rejects.toThrow()
      expect(readRecord(gameScope(game), 'install')).toBeUndefined()
      expect(await readFile(join(game, '.csore_install.json'), 'utf8')).toContain('installed')
      await writeFile(join(game, '.csore_pending_audio_patch.json'), JSON.stringify({ toVersion: 'next', audioPkgs: [] }))
      expect((await readInstallState(game))?.version).toBe('installed')
      expect((await readPendingAudioPatch(game))?.toVersion).toBe('next')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rolls back a failed multi-record write', () => {
    writeRecords('launcher', { first: 'original' })
    const circular: Record<string, unknown> = {}; circular.self = circular
    expect(() => writeRecords('launcher', { first: 'changed', second: circular })).toThrow()
    expect(readRecord('launcher', 'first')).toBe('original')
    expect(readRecord('launcher', 'second')).toBeUndefined()
  })

  it('restores a damaged database from backup and blocks the triggering operation instead of returning an empty installation', async () => {
    const { root, game } = await fixture()
    try {
      await writeInstallState(game, { version: 'installed', installDir: game, files: [] })
      await writeFile(databasePath(), 'damaged SQLite bytes')
      await expect(readInstallState(game)).rejects.toThrow(/backup was restored/i)
      expect((await readInstallState(game))?.version).toBe('installed')
      expect((await readdir(root)).some(name => name.startsWith('launcher.db.damaged-'))).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not create an empty database after its main file disappears', async () => {
    const { root, game } = await fixture()
    try {
      await writeInstallState(game, { version: 'installed', installDir: game, files: [] })
      await rm(databasePath())
      await expect(readInstallState(game)).rejects.toThrow(/backup was restored/i)
      expect((await readInstallState(game))?.version).toBe('installed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps a damaged database without a backup intact and refuses game operations', async () => {
    const { root, game } = await fixture()
    try {
      await writeFile(databasePath(), 'damaged, do not overwrite')
      await expect(readInstallState(game)).rejects.toThrow(/no backup/i)
      expect(await readFile(databasePath(), 'utf8')).toBe('damaged, do not overwrite')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('keeps UI preferences and game metadata through a reopen and does not resurrect uninstalled metadata', async () => {
    const { root, game } = await fixture()
    try {
      writePreferences({ backgroundMode: 'image', confirmedInstallDir: game })
      writePreferences({ backgroundMode: 'video', confirmedInstallDir: null }, true)
      expect(readPreferences()).toEqual({ backgroundMode: 'image', confirmedInstallDir: game })
      await writeInstallState(game, { version: 'installed', installDir: game, files: [] })
      const settings = await readSettings(root)
      await writeSettings(root, { ...settings, lang: 'na_id' })
      configureDatabaseDirectory(root)
      expect((await readSettings(root)).lang).toBe('na_id')
      forgetGameRecords(game)
      await writeFile(join(game, '.csore_install.json'), JSON.stringify({ version: 'stale', files: [] }))
      expect(await readInstallState(game)).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('discards damaged legacy verification cache without discarding the installation', async () => {
    const { root, game } = await fixture()
    try {
      await writeFile(join(game, '.csore_install.json'), JSON.stringify({ version: 'installed', files: [] }))
      await writeFile(join(game, '.csore_verify_cache.json'), '{')
      expect((await readInstallState(game))?.version).toBe('installed')
      expect(await readGameRecord(game, 'verifyCache')).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
