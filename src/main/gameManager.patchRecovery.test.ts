
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeInstallState, readInstallState } from './installState'
import type { GamePackageEntry } from './launcherApi'

const mockUserDataDir = { current: '' }
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataDir.current
      if (name === 'temp') return tmpdir()
      return `/mock/${name}`
    }
  }
}))

vi.mock('./launcherApi', () => ({
  fetchLauncherInfo: vi.fn()
}))

vi.mock('./installManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./installManager')>()
  return {
    ...actual,

    reassembleParts: vi.fn().mockResolvedValue(undefined)
  }
})

vi.mock('./patcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./patcher')>()
  return {
    ...actual,
    readManifest: vi.fn().mockResolvedValue({ entries: [] }),
    applyPatch: vi.fn()
  }
})

vi.mock('./zipExtract', () => ({
  extractZip: vi.fn().mockResolvedValue(undefined)
}))

import { fetchLauncherInfo } from './launcherApi'
import { applyPatch, PatchVerificationError } from './patcher'
import { performInstallOrUpdate } from './gameManager'

describe('performInstallOrUpdate patch-verification recovery', () => {
  let userDataDir: string
  let installDir: string

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
  })

  it('falls back to a fresh install when applyPatch rejects with an old_md5 mismatch', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-patchfallback-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-patchfallback-'))
    await writeInstallState(installDir, { version: '1.0.0', installDir, files: [] })

    const targetBlock = {
      version: '1.1.0',
      game_pkgs: [{ url: 'https://fixture.test/part0', md5: 'x', size: '10', decompressed_size: '10' }],
      res_list_url: ''
    }
    const patchBlock = {
      version: '1.0.0',
      game_pkgs: [{ url: 'https://fixture.test/patch-part0', md5: 'y', size: '10', decompressed_size: '10' }],
      res_list_url: ''
    }

    vi.mocked(fetchLauncherInfo).mockResolvedValue({
      game: { id: '1', biz: 'csore_global' },
      main: { major: targetBlock, patches: [patchBlock], required_client_version: '1.0.0' }
    } as GamePackageEntry)

    const fakeEntry = {
      path: 'foo.bin',
      action: 'modified' as const,
      old_md5: 'expected-md5',
      new_md5: 'new-md5',
      delta_file: 'foo.bin.delta'
    }
    vi.mocked(applyPatch).mockRejectedValueOnce(
      new PatchVerificationError(
        fakeEntry,
        "installed file's MD5 (actual-md5) does not match old_md5 (expected-md5) -- stale or corrupted install",
        'old_md5_mismatch'
      )
    )

    await expect(performInstallOrUpdate(installDir, () => {})).resolves.toBeUndefined()

    const state = await readInstallState(installDir)
    expect(state?.version).toBe('1.1.0')
  })

  it('does not swallow a non-old_md5 verification failure into a fresh-install recovery', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-patchfallback-other-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-patchfallback-other-'))
    await writeInstallState(installDir, { version: '1.0.0', installDir, files: [] })

    const targetBlock = {
      version: '1.1.0',
      game_pkgs: [{ url: 'https://fixture.test/part0', md5: 'x', size: '10', decompressed_size: '10' }],
      res_list_url: ''
    }
    const patchBlock = {
      version: '1.0.0',
      game_pkgs: [{ url: 'https://fixture.test/patch-part0', md5: 'y', size: '10', decompressed_size: '10' }],
      res_list_url: ''
    }

    vi.mocked(fetchLauncherInfo).mockResolvedValue({
      game: { id: '1', biz: 'csore_global' },
      main: { major: targetBlock, patches: [patchBlock], required_client_version: '1.0.0' }
    } as GamePackageEntry)

    const fakeEntry = {
      path: 'foo.bin',
      action: 'modified' as const,
      old_md5: 'expected-md5',
      new_md5: 'new-md5',
      delta_file: 'foo.bin.delta'
    }
    vi.mocked(applyPatch).mockRejectedValueOnce(
      new PatchVerificationError(fakeEntry, "staged result's MD5 does not match new_md5", 'other')
    )

    await expect(performInstallOrUpdate(installDir, () => {})).rejects.toBeInstanceOf(PatchVerificationError)

    const state = await readInstallState(installDir)
    expect(state?.version).toBe('1.0.0')
  })
})
