
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, rm, chmod, mkdir, writeFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import {
  selectLaunchFn,
  checkDirWritable,
  setApprovedInstallDir,
  isApprovedInstallDir,
  verifyInstall,
  uninstallGame,
  getDWProtonStatus,
  getWhiskyStatus,
  redownloadDWProton
} from './gameManager'
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

    if (process.platform === 'win32') return
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

describe('verifyInstall', () => {
  let installDir: string

  afterEach(async () => {
    await rm(installDir, { recursive: true, force: true })
  })

  it('throws a clear error when there is no InstallState at all', async () => {
    installDir = await mkdtemp(join(tmpdir(), 'csore-verify-none-'))
    await expect(verifyInstall(installDir)).rejects.toThrow(/no install found/i)
  })

  it('reports ok:true when every recorded file matches its recorded MD5', async () => {
    installDir = await mkdtemp(join(tmpdir(), 'csore-verify-ok-'))
    const content = Buffer.from('real game bytes')
    await mkdir(join(installDir, 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Bin', 'game.exe'), content)
    const md5 = createHash('md5').update(content).digest('hex')
    await writeInstallState(installDir, {
      version: '1.0.0',
      installDir,
      files: [{ path: 'Bin/game.exe', md5 }]
    })

    const result = await verifyInstall(installDir)
    expect(result).toEqual({ ok: true, corruptFiles: [], missingFiles: [] })
  })

  it('reports a mutated file as corrupt', async () => {
    installDir = await mkdtemp(join(tmpdir(), 'csore-verify-corrupt-'))
    const content = Buffer.from('real game bytes')
    await mkdir(join(installDir, 'Bin'), { recursive: true })
    const filePath = join(installDir, 'Bin', 'game.exe')
    await writeFile(filePath, content)
    const recordedMd5 = createHash('md5').update(content).digest('hex')
    await writeInstallState(installDir, {
      version: '1.0.0',
      installDir,
      files: [{ path: 'Bin/game.exe', md5: recordedMd5 }]
    })

    await writeFile(filePath, Buffer.from('corrupted bytes!'))

    const result = await verifyInstall(installDir)
    expect(result.ok).toBe(false)
    expect(result.corruptFiles).toEqual(['Bin/game.exe'])
    expect(result.missingFiles).toEqual([])
  })

  it('reports a deleted file as missing', async () => {
    installDir = await mkdtemp(join(tmpdir(), 'csore-verify-missing-'))
    await writeInstallState(installDir, {
      version: '1.0.0',
      installDir,
      files: [{ path: 'Bin/game.exe', md5: 'deadbeef' }]
    })

    const result = await verifyInstall(installDir)
    expect(result.ok).toBe(false)
    expect(result.corruptFiles).toEqual([])
    expect(result.missingFiles).toEqual(['Bin/game.exe'])
  })
})

describe('uninstallGame', () => {
  let installDir: string
  let userDataDir: string

  afterEach(async () => {
    await rm(installDir, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('deletes the install directory and clears both the in-memory and persisted approval', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-uninstall-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-uninstall-'))
    await writeInstallState(installDir, { version: '1.0.0', installDir, files: [] })
    await setApprovedInstallDir(installDir)

    await uninstallGame(installDir)

    await expect(access(installDir)).rejects.toThrow()
    expect(await isApprovedInstallDir(installDir)).toBe(false)
  })

  it('refuses to run while another operation is already in progress', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-uninstall-race-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-uninstall-race-'))
    await writeInstallState(installDir, { version: '1.0.0', installDir, files: [] })

    const firstCall = uninstallGame(installDir)
    await expect(uninstallGame(installDir)).rejects.toThrow(/already in progress/i)
    await firstCall
  })
})

describe('getDWProtonStatus', () => {
  let userDataDir: string

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('reports not installed when nothing is under runtimes/proton', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-dwproton-status-none-'))
    mockUserDataDir.current = userDataDir
    expect(await getDWProtonStatus()).toEqual({ installed: false, version: null })
  })

  it('reports the installed tag when a complete DWProton build is present', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-dwproton-status-'))
    mockUserDataDir.current = userDataDir
    const protonDir = join(userDataDir, 'runtimes', 'proton', 'dwproton-2.0')
    await mkdir(protonDir, { recursive: true })
    await writeFile(join(protonDir, 'proton'), '#!/bin/sh\n')

    expect(await getDWProtonStatus()).toEqual({ installed: true, version: 'dwproton-2.0' })
  })
})

describe('getWhiskyStatus', () => {
  it('reports not found on a machine with no Whisky bottle (the normal case outside real macOS hardware)', async () => {
    const status = await getWhiskyStatus()
    expect(status.found).toBe(false)
    expect(status.bottlePath).toBeNull()
  })
})

describe('redownloadDWProton', () => {
  let userDataDir: string
  let fixtureServerDir: string
  let originalFetch: typeof fetch

  afterEach(async () => {
    global.fetch = originalFetch
    await rm(userDataDir, { recursive: true, force: true })
    await rm(fixtureServerDir, { recursive: true, force: true })
  })

  it('forces a fresh download+extract even though a build is already installed', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-dwproton-redownload-'))
    mockUserDataDir.current = userDataDir

    const staleDir = join(userDataDir, 'runtimes', 'proton', 'dwproton-old')
    await mkdir(staleDir, { recursive: true })
    await writeFile(join(staleDir, 'proton'), '#!/bin/sh\n')

    fixtureServerDir = await mkdtemp(join(tmpdir(), 'csore-dwproton-redownload-fixture-'))
    const srcDir = join(fixtureServerDir, 'src')
    await mkdir(join(srcDir, 'dwproton-new'), { recursive: true })
    await writeFile(join(srcDir, 'dwproton-new', 'proton'), '#!/bin/sh\n')
    const tarballPath = join(fixtureServerDir, 'dwproton-new-x86_64.tar.xz')
    await execFileAsync('tar', ['cJf', tarballPath, '-C', srcDir, 'dwproton-new'])
    const { readFile } = await import('fs/promises')
    const tarballBytes = await readFile(tarballPath)
    const sha512 = createHash('sha512').update(tarballBytes).digest('hex')

    const giteaReleasesJson = JSON.stringify([
      {
        tag_name: 'dwproton-new',
        assets: [
          { name: 'dwproton-new-x86_64.tar.xz', browser_download_url: 'https://fixture.test/redl-tarball' },
          { name: 'dwproton-new-x86_64.sha512sum', browser_download_url: 'https://fixture.test/redl-sha512sum' }
        ]
      }
    ])

    let downloadCount = 0
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('dawn.wine')) return new Response(giteaReleasesJson, { status: 200 })
      if (url === 'https://fixture.test/redl-tarball') {
        downloadCount++
        return new Response(new Uint8Array(tarballBytes), { status: 200 })
      }
      if (url === 'https://fixture.test/redl-sha512sum') {
        return new Response(`${sha512}  dwproton-new-x86_64.tar.xz\n`, { status: 200 })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as unknown as typeof fetch

    const progress: unknown[] = []
    await redownloadDWProton((u) => progress.push(u))

    expect(downloadCount).toBe(1)
    expect(progress.length).toBeGreaterThan(0)
    await expect(
      access(join(userDataDir, 'runtimes', 'proton', 'dwproton-new', 'proton'))
    ).resolves.toBeUndefined()
    // Stale previously-installed tag is untouched by redownload.
    await expect(access(join(staleDir, 'proton'))).resolves.toBeUndefined()
  })
})
