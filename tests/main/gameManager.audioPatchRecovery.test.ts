
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeInstallState, readInstallState, readPendingAudioPatch } from '../../src/main/installState'
import type { GamePackageEntry } from '../../src/main/launcherApi'

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

vi.mock('../../src/main/launcherApi', () => ({
  fetchLauncherInfo: vi.fn()
}))

vi.mock('../../src/main/installManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/installManager')>()
  return {
    ...actual,

    reassembleParts: vi.fn().mockResolvedValue(undefined)
  }
})

vi.mock('../../src/main/patcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/patcher')>()
  return {
    ...actual,
    readManifest: vi.fn().mockResolvedValue({ entries: [] }),
    applyPatch: vi.fn()
  }
})

vi.mock('../../src/main/zipExtract', () => ({
  extractZip: vi.fn().mockResolvedValue([])
}))

import { fetchLauncherInfo } from '../../src/main/launcherApi'
import { applyPatch, PatchVerificationError } from '../../src/main/patcher'
import { performInstallOrUpdate } from '../../src/main/gameManager'

describe('applyAudioPatchContinuation old_md5_mismatch recovery', () => {
  let userDataDir: string
  let installDir: string

  afterEach(async () => {
    vi.clearAllMocks()
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
  })

  it('falls back to a fresh install when the AUDIO side genuinely fails its old_md5 check, instead of retrying forever', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-audiorecover-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-audiorecover-'))
    await writeInstallState(installDir, { version: '1.0.0', installDir, files: [] })

    const targetBlock = {
      version: '1.1.0',
      game_pkgs: [{ url: 'https://fixture.test/part0', md5: 'x', size: '10', decompressed_size: '10' }],
      res_list_url: ''
    }
    const patchBlock = {
      version: '1.0.0',
      game_pkgs: [{ url: 'https://fixture.test/patch-part0', md5: 'y', size: '10', decompressed_size: '10' }],
      audio_pkgs: [{ url: 'https://fixture.test/audio-patch-part0', md5: 'z', size: '10', decompressed_size: '10' }],
      res_list_url: ''
    }

    vi.mocked(fetchLauncherInfo).mockResolvedValue({
      game: { id: '1', biz: 'csore_global' },
      main: { major: targetBlock, patches: [patchBlock], required_client_version: '1.0.0' }
    } as GamePackageEntry)

    const fakeGameEntry = {
      path: 'foo.bin',
      action: 'modified' as const,
      old_md5: 'expected-md5',
      new_md5: 'new-md5',
      delta_file: 'foo.bin.delta'
    }
    const fakeAudioEntry = {
      path: 'Audio/voice_en.bin',
      action: 'modified' as const,
      old_md5: 'expected-audio-md5',
      new_md5: 'new-audio-md5',
      delta_file: 'voice_en.bin.delta'
    }

    vi.mocked(applyPatch)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new PatchVerificationError(
          fakeAudioEntry,
          "installed file's MD5 (actual-audio-md5) does not match old_md5 (expected-audio-md5) -- stale or corrupted install",
          'old_md5_mismatch'
        )
      )
    void fakeGameEntry

    const result = await performInstallOrUpdate(installDir, () => {})
    expect(result).toEqual({ status: 'completed' })

    const state = await readInstallState(installDir)
    expect(state?.version).toBe('1.1.0')

    expect(await readPendingAudioPatch(installDir)).toBeNull()
  })
})
