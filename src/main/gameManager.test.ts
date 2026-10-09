
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, rm, chmod, mkdir, writeFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { selectLaunchFn, checkDirWritable, setApprovedInstallDir, isApprovedInstallDir } from './gameManager'
import { writeInstallState } from './installState'

const execFileAsync = promisify(execFile)

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

describe('persisted install-dir approval survives a simulated app restart', () => {
  let userDataDir: string
  let installDir: string

  afterEach(async () => {
    vi.resetModules()
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
  })

  it('stays approved after a fresh module load, without needing .csore_install.json to exist', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-approve-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-approved-persist-'))

    const { setApprovedInstallDir: setApprovedFresh } = await import('./gameManager')
    await setApprovedFresh(installDir)

    // Simulate the app restarting: a fresh module instance has no idea
    // this directory was approved in memory.
    vi.resetModules()
    const { isApprovedInstallDir: isApprovedAfterRestart } = await import('./gameManager')

    expect(await isApprovedAfterRestart(installDir)).toBe(true)

    await expect(access(join(installDir, '.csore_install.json'))).rejects.toThrow()
  })

  it('does not approve a directory that was never chosen/persisted', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-approve-empty-'))
    mockUserDataDir.current = userDataDir
    installDir = join(tmpdir(), `csore-not-approved-${Date.now()}`)

    vi.resetModules()
    const { isApprovedInstallDir: isApprovedFresh } = await import('./gameManager')
    expect(await isApprovedFresh(installDir)).toBe(false)
  })
})

describe('runLinuxLaunch (via selectLaunchFn) starting from a clean machine', () => {
  let userDataDir: string
  let installDir: string
  let fixtureServerDir: string
  let originalFetch: typeof fetch

  afterEach(async () => {
    vi.doUnmock('child_process')
    vi.resetModules()
    global.fetch = originalFetch
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
    await rm(fixtureServerDir, { recursive: true, force: true })
  })

  it('creates the runtimes dir, downloads+verifies+extracts DWProton, and launches', async () => {
    originalFetch = global.fetch

    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-'))
    mockUserDataDir.current = userDataDir

    installDir = await mkdtemp(join(tmpdir(), 'csore-install-'))
    await mkdir(join(installDir, 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Bin', 'cstrike-online.exe'), 'fake exe bytes')

    // Build a real fixture DWProton tarball + its real sha512sum.
    fixtureServerDir = await mkdtemp(join(tmpdir(), 'csore-dwproton-fixture-'))
    const srcDir = join(fixtureServerDir, 'src')
    await mkdir(join(srcDir, 'dwproton-1.0'), { recursive: true })
    await writeFile(join(srcDir, 'dwproton-1.0', 'proton'), '#!/bin/sh\n')
    const tarballPath = join(fixtureServerDir, 'dwproton-1.0-x86_64.tar.xz')
    await execFileAsync('tar', ['cJf', tarballPath, '-C', srcDir, 'dwproton-1.0'])
    const { readFile } = await import('fs/promises')
    const tarballBytes = await readFile(tarballPath)
    const sha512 = createHash('sha512').update(tarballBytes).digest('hex')

    const giteaReleasesJson = JSON.stringify([
      {
        tag_name: 'dwproton-1.0',
        assets: [
          { name: 'dwproton-1.0-x86_64.tar.xz', browser_download_url: 'https://fixture.test/tarball' },
          { name: 'dwproton-1.0-x86_64.sha512sum', browser_download_url: 'https://fixture.test/sha512sum' }
        ]
      }
    ])

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('dawn.wine')) {
        return new Response(giteaReleasesJson, { status: 200 })
      }
      if (url === 'https://fixture.test/tarball') {
        return new Response(new Uint8Array(tarballBytes), { status: 200 })
      }
      if (url === 'https://fixture.test/sha512sum') {
        return new Response(`${sha512}  dwproton-1.0-x86_64.tar.xz\n`, { status: 200 })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as unknown as typeof fetch

    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
          const child = new EventEmitter() as EventEmitter & { unref: () => void }
          child.unref = () => {}
          setImmediate(() => child.emit('spawn'))
          return child
        })
      }
    })

    const { selectLaunchFn: selectLaunchFnFresh } = await import('./gameManager')
    const launch = selectLaunchFnFresh('linux')
    await expect(launch(installDir, [])).resolves.toBeUndefined()

    const runtimesDir = join(userDataDir, 'runtimes')
    await expect(access(join(runtimesDir, 'proton', 'dwproton-1.0', 'proton'))).resolves.toBeUndefined()
    // The downloaded tarball must not be left behind.
    await expect(access(join(runtimesDir, 'dwproton-1.0.tar.xz'))).rejects.toThrow()
  })
})
