import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { activeGame, selectGame } from '../../src/main/activeGame'
import { setApprovedInstallDir, getSelectedInstallDir } from '../../src/main/gameManager'
import { resolveInstallLocation } from '../../src/main/installLocation'
import { readPreferences, writePreferences } from '../../src/main/preferences'
import { readSettings, writeSettings, DEFAULT_SETTINGS } from '../../src/main/settings'
import { readInstallState, writeInstallState } from '../../src/main/installState'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
let root: string
beforeEach(async () => { selectGame('csore_global'); root = await mkdtemp(join(tmpdir(), 'tia-multi-game-')) })
afterEach(async () => { selectGame('csore_global'); await rm(root, { recursive: true, force: true }) })
it('creates sibling game folders and never reuses another registered game root', async () => {
  const cso = await resolveInstallLocation(root)
  expect(cso).toBe(join(root, 'Tia-CSORSE'))
  await setApprovedInstallDir(cso)
  selectGame('cedar_global')
  const silver = await resolveInstallLocation(root)
  expect(silver).toBe(join(root, 'Tia-SilverPalace'))
  await setApprovedInstallDir(silver)
  await expect(resolveInstallLocation(cso)).rejects.toThrow(/another game/)
  expect((await stat(cso)).isDirectory()).toBe(true)
  expect((await stat(silver)).isDirectory()).toBe(true)
})
it('keeps selected directories, confirmations and launch commands independent', async () => {
  const cso = join(root, 'Tia-CSORSE'), silver = join(root, 'Tia-SilverPalace')
  await mkdir(cso); await mkdir(silver)
  await setApprovedInstallDir(cso)
  writePreferences({ confirmedInstallDir: cso })
  await writeSettings(root, { ...DEFAULT_SETTINGS, launchCommand: 'cso-wrapper %command%' })
  selectGame('cedar_global')
  expect(readPreferences().confirmedInstallDir).toBeNull()
  expect((await readSettings(root)).launchCommand).toBeNull()
  await setApprovedInstallDir(silver)
  writePreferences({ confirmedInstallDir: silver })
  await writeSettings(root, { ...DEFAULT_SETTINGS, launchCommand: 'silver-wrapper %command%' })
  selectGame('csore_global')
  expect(await getSelectedInstallDir()).toBe(cso)
  expect(readPreferences().confirmedInstallDir).toBe(cso)
  expect((await readSettings(root)).launchCommand).toBe('cso-wrapper %command%')
  selectGame('cedar_global')
  expect(await getSelectedInstallDir()).toBe(silver)
  expect(readPreferences().confirmedInstallDir).toBe(silver)
  expect((await readSettings(root)).launchCommand).toBe('silver-wrapper %command%')
})
it('rejects foreign installation metadata and unknown game selections', async () => {
  await writeInstallState(root, { version: '1', installDir: root, files: [] })
  selectGame('cedar_global')
  expect(await readInstallState(root)).toBeNull()
  await writeInstallState(root, { version: '2', installDir: root, files: [] })
  expect((await readInstallState(root))?.gameBiz).toBe('cedar_global')
  selectGame('csore_global')
  expect(await readInstallState(root)).toBeNull()
  expect(() => selectGame('../unknown')).toThrow(/Unknown game/)
  expect(activeGame().biz).toBe('csore_global')
})
it('finds the Silver Palace executable in its own profile', async () => {
  selectGame('cedar_global')
  const exe = join(root, activeGame().executable)
  await mkdir(join(exe, '..'), { recursive: true }); await writeFile(exe, 'fixture')
  const { findGameExecutable } = await import('../../src/main/launcher/windows')
  expect(await findGameExecutable(root)).toBe(exe)
  expect(await resolveInstallLocation(root)).toBe(root)
})
