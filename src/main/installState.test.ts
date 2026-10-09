
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readInstallState, writeInstallState, installStatePath, type InstallState } from './installState'

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
