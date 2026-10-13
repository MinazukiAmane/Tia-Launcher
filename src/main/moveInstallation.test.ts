import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { moveInstallDirectory } from './moveInstallation'
import { readInstallState, writeInstallState } from './installState'
import { isOperationInProgress, moveInstallation, verifyInstall } from './gameManager'

let root: string
vi.mock('electron', () => ({ app: { getPath: () => root } }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), cp: vi.fn(actual.cp), rm: vi.fn(actual.rm) }
})

describe('moving an installed game', () => {
  let source: string
  let destination: string
  let actual: typeof import('fs/promises')

  beforeEach(async () => {
    actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    vi.mocked(rename).mockReset().mockImplementation(actual.rename)
    vi.mocked(cp).mockReset().mockImplementation(actual.cp)
    vi.mocked(rm).mockReset().mockImplementation(actual.rm)
    root = await mkdtemp(join(tmpdir(), 'csore-move-'))
    source = join(root, 'old-game')
    destination = join(root, 'new-game')
    await mkdir(join(source, 'Bin'), { recursive: true })
    await mkdir(join(source, 'Data'))
    await mkdir(join(source, 'Saves'))
    await mkdir(destination)
    await writeFile(join(source, 'Bin', 'cstrike-online.exe'), 'game fixture')
    await writeFile(join(source, 'Data', 'game.dat'), 'game data')
    await writeFile(join(source, 'Saves', 'custom.dat'), 'unlisted user file')
    await writeFile(join(source, '.csore_pending_audio_patch.json'), '{"toVersion":"next","audioPkgs":[]}')
    await writeInstallState(source, { version: 'fixture', installDir: source, files: [] })
  })

  afterEach(async () => {
    await actual.rm(root, { recursive: true, force: true })
  })

  async function expectMoved(): Promise<void> {
    expect(await readFile(join(destination, 'Bin', 'cstrike-online.exe'), 'utf8')).toBe('game fixture')
    expect(await readFile(join(destination, 'Data', 'game.dat'), 'utf8')).toBe('game data')
    expect(await readFile(join(destination, 'Saves', 'custom.dat'), 'utf8')).toBe('unlisted user file')
    expect(await readFile(join(destination, '.csore_pending_audio_patch.json'), 'utf8')).toContain('next')
    expect((await readInstallState(destination))?.installDir).toBe(destination)
  }

  it('moves all files on the same drive and updates metadata without copying', async () => {
    expect(await moveInstallDirectory(source, destination)).toEqual({ installDir: destination })
    await expectMoved()
    await expect(readdir(source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(cp).not.toHaveBeenCalled()
  })

  it('refuses a nonempty destination without changing either folder', async () => {
    await writeFile(join(destination, 'keep.txt'), 'existing destination file')
    await expect(moveInstallDirectory(source, destination)).rejects.toThrow(/empty folder/)
    expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('existing destination file')
    expect((await readInstallState(source))?.installDir).toBe(source)
  })

  it('refuses the same folder and nested destinations', async () => {
    await expect(moveInstallDirectory(source, source)).rejects.toThrow(/outside/)
    await expect(moveInstallDirectory(source, join(source, 'nested'))).rejects.toThrow(/outside/)
    await expect(moveInstallDirectory(source, root)).rejects.toThrow(/outside/)
  })

  it('copies and verifies every file before removing the source on a different drive', async () => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    const progress = vi.fn()
    await moveInstallDirectory(source, destination, progress)
    await expectMoved()
    await expect(readdir(source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(cp).toHaveBeenCalledOnce()
    expect(progress.mock.calls.some(([value]) => value.phase === 'copying')).toBe(true)
    expect(progress.mock.calls.some(([value]) => value.phase === 'verifying')).toBe(true)
  })

  it('preserves source files and removes staging after a copy fails', async () => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    vi.mocked(cp).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await expect(moveInstallDirectory(source, destination)).rejects.toThrow('disk full')
    expect(await readFile(join(source, 'Saves', 'custom.dat'), 'utf8')).toBe('unlisted user file')
    expect((await readInstallState(source))?.installDir).toBe(source)
    expect(await readdir(destination)).toEqual([])
    expect((await readdir(root)).some(name => name.startsWith('.csore-move-'))).toBe(false)
  })

  it('rejects a corrupted copy and leaves the original installation intact', async () => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    vi.mocked(cp).mockImplementationOnce(async (from, to, options) => {
      await actual.cp(from, to, options)
      await writeFile(join(String(to), 'Data', 'game.dat'), 'bad bytes')
    })
    await expect(moveInstallDirectory(source, destination)).rejects.toThrow(/verification failed/)
    expect(await readFile(join(source, 'Data', 'game.dat'), 'utf8')).toBe('game data')
    expect((await readInstallState(source))?.installDir).toBe(source)
  })

  it('rolls back a same-drive move if committing the destination fails', async () => {
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to) === destination) throw Object.assign(new Error('destination blocked'), { code: 'EACCES' })
      await actual.rename(from, to)
    })
    await expect(moveInstallDirectory(source, destination)).rejects.toThrow('destination blocked')
    expect(await readFile(join(source, 'Data', 'game.dat'), 'utf8')).toBe('game data')
    expect((await readInstallState(source))?.installDir).toBe(source)
    expect(await readdir(destination)).toEqual([])
  })

  it('reports an old-folder cleanup failure while retaining a complete destination', async () => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (String(path) === source) throw new Error('source locked')
      await actual.rm(path, options)
    })
    const result = await moveInstallDirectory(source, destination)
    expect(result.warning).toContain('remain at the old location')
    await expectMoved()
    expect(await readFile(join(source, 'Data', 'game.dat'), 'utf8')).toBe('game data')
  })

  it('locks other operations during the move and persists approval for the new location', async () => {
    let blocked: Promise<unknown> | undefined
    await moveInstallation(source, destination, () => {
      expect(isOperationInProgress()).toBe(true)
      blocked ??= expect(verifyInstall(source)).rejects.toThrow(/current operation/)
    })
    await blocked
    expect(isOperationInProgress()).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'approved-install-dir.json'), 'utf8')).installDir).toBe(destination)
    await expectMoved()
  })
})
