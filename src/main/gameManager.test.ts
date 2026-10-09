
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { selectLaunchFn, checkDirWritable, setApprovedInstallDir, isApprovedInstallDir } from './gameManager'
import { writeInstallState } from './installState'

describe('selectLaunchFn', () => {
  it('returns the Windows launcher for win32', () => {
    expect(selectLaunchFn('win32').name).toBe('runWindowsLaunch')
  })

  it('returns the Linux launcher for linux', () => {
    expect(selectLaunchFn('linux').name).toBe('runLinuxLaunch')
  })

  it('returns the macOS launcher for darwin', () => {
    expect(selectLaunchFn('darwin').name).toBe('runMacLaunch')
  })

  it('throws for an unsupported platform', () => {
    expect(() => selectLaunchFn('aix' as NodeJS.Platform)).toThrow(/unsupported platform/i)
  })
})

describe('checkDirWritable', () => {
  let dir: string
  afterEach(async () => {
    await chmod(dir, 0o755).catch(() => {}) // restore so rm can clean up
    await rm(dir, { recursive: true, force: true })
  })

  it('returns true for a normal writable directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'csore-writable-test-'))
    expect(await checkDirWritable(dir)).toBe(true)
  })

  it('returns false for a read-only directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'csore-writable-test-'))
    await chmod(dir, 0o555) // read+execute only, no write

    if (process.getuid && process.getuid() === 0) return
    expect(await checkDirWritable(dir)).toBe(false)
  })
})

describe('isApprovedInstallDir / setApprovedInstallDir', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('approves a directory set via setApprovedInstallDir', async () => {
    const chosen = join(tmpdir(), `csore-approved-${Date.now()}`)
    setApprovedInstallDir(chosen)
    expect(await isApprovedInstallDir(chosen)).toBe(true)
  })

  it('rejects a directory that was never approved and has no install state', async () => {
    const neverApproved = join(tmpdir(), `csore-never-approved-${Date.now()}`)
    expect(await isApprovedInstallDir(neverApproved)).toBe(false)
  })

  it('approves a directory that already holds a valid .csore_install.json, even if never chosen this session', async () => {
    dir = await mkdtemp(join(tmpdir(), 'csore-preexisting-install-'))
    await writeInstallState(dir, { version: '1.0.0', installDir: dir, files: [] })
    expect(await isApprovedInstallDir(dir)).toBe(true)
  })
})
