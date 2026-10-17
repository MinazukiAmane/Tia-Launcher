
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readInstallState,
  writeInstallState,
  installStatePath,
  mergeManifestEntries,
  type InstallState,
  type InstalledFileEntry
} from '../../src/main/installState'
import type { ManifestEntry } from '../../src/main/patcher'

let tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-install-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('readInstallState', () => {
  it('returns null when no state file exists', async () => {
    const dir = await makeTempDir()
    expect(await readInstallState(dir)).toBeNull()
  })

  it('round-trips what writeInstallState wrote', async () => {
    const dir = await makeTempDir()
    const state: InstallState = {
      version: '0.1.51',
      installDir: dir,
      files: [{ path: 'Bin/game.exe', md5: 'abc123' }]
    }
    await writeInstallState(dir, state)
    const got = await readInstallState(dir)
    expect(got).toEqual(state)
  })

  it('a second write overwrites the first', async () => {
    const dir = await makeTempDir()
    await writeInstallState(dir, { version: '0.1.51', installDir: dir, files: [] })
    await writeInstallState(dir, { version: '0.1.52', installDir: dir, files: [] })
    const got = await readInstallState(dir)
    expect(got?.version).toBe('0.1.52')
  })
})

describe('installStatePath', () => {
  it('is .csore_install.json inside the install dir', () => {
    expect(installStatePath('/some/dir')).toBe(join('/some/dir', '.csore_install.json'))
  })
})

describe('mergeManifestEntries', () => {
  it('returns the previous list unchanged when there are no entries', () => {
    const previous: InstalledFileEntry[] = [{ path: 'Bin/game.exe', md5: 'abc' }]
    expect(mergeManifestEntries(previous, [])).toEqual(previous)
  })

  it('returns an empty list when both previous and entries are empty', () => {
    expect(mergeManifestEntries([], [])).toEqual([])
  })

  it('removes a file matched by path', () => {
    const previous: InstalledFileEntry[] = [
      { path: 'Bin/game.exe', md5: 'abc' },
      { path: 'Data/old.txt', md5: 'def' }
    ]
    const entries: ManifestEntry[] = [{ path: 'Data/old.txt', action: 'removed' }]
    expect(mergeManifestEntries(previous, entries)).toEqual([{ path: 'Bin/game.exe', md5: 'abc' }])
  })

  it('adds a new file not present in the previous list', () => {
    const previous: InstalledFileEntry[] = [{ path: 'Bin/game.exe', md5: 'abc' }]
    const entries: ManifestEntry[] = [{ path: 'Data/new.txt', action: 'added', new_md5: 'xyz' }]
    expect(mergeManifestEntries(previous, entries)).toEqual([
      { path: 'Bin/game.exe', md5: 'abc' },
      { path: 'Data/new.txt', md5: 'xyz' }
    ])
  })

  it('updates an existing file\'s md5 for a modified entry', () => {
    const previous: InstalledFileEntry[] = [{ path: 'Data/file.txt', md5: 'old-md5' }]
    const entries: ManifestEntry[] = [{ path: 'Data/file.txt', action: 'modified', new_md5: 'new-md5' }]
    expect(mergeManifestEntries(previous, entries)).toEqual([{ path: 'Data/file.txt', md5: 'new-md5' }])
  })

  it('handles a mix of removed, added, and modified entries in one call', () => {
    const previous: InstalledFileEntry[] = [
      { path: 'Bin/game.exe', md5: 'exe-md5' },
      { path: 'Data/file.txt', md5: 'old-md5' },
      { path: 'Data/gone.txt', md5: 'gone-md5' }
    ]
    const entries: ManifestEntry[] = [
      { path: 'Data/gone.txt', action: 'removed' },
      { path: 'Data/file.txt', action: 'modified', new_md5: 'new-md5' },
      { path: 'Data/new.txt', action: 'added', new_md5: 'new-file-md5' }
    ]
    expect(mergeManifestEntries(previous, entries)).toEqual([
      { path: 'Bin/game.exe', md5: 'exe-md5' },
      { path: 'Data/file.txt', md5: 'new-md5' },
      { path: 'Data/new.txt', md5: 'new-file-md5' }
    ])
  })

  it('adds entries to an empty previous list', () => {
    const entries: ManifestEntry[] = [{ path: 'Data/new.txt', action: 'added', new_md5: 'new-file-md5' }]
    expect(mergeManifestEntries([], entries)).toEqual([{ path: 'Data/new.txt', md5: 'new-file-md5' }])
  })

  it('a removed entry that does not match anything in the previous list is a no-op for that entry', () => {
    const previous: InstalledFileEntry[] = [{ path: 'Bin/game.exe', md5: 'abc' }]
    const entries: ManifestEntry[] = [{ path: 'Data/does-not-exist.txt', action: 'removed' }]
    expect(mergeManifestEntries(previous, entries)).toEqual(previous)
  })
})
