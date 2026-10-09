import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createServer, type Server } from 'http'
import { mkdtemp, rm, mkdir, access, writeFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import {
  fetchLatestDWProtonRelease,
  dwprotonInstallDir,
  isDWProtonInstalled,
  extractDWProtonTarball,
  verifyTarballSha512,
  launchLinux
} from './linux'

const execFileAsync = promisify(execFile)

const SAMPLE_RELEASES = [
  {
    id: 600,
    tag_name: 'dwproton-11.0-14',
    assets: [
      {
        name: 'dwproton-11.0-14-x86_64.sha512sum',
        browser_download_url: 'http://PLACEHOLDER/dwproton-11.0-14-x86_64.sha512sum'
      },
      {
        name: 'dwproton-11.0-14-x86_64.tar.xz',
        browser_download_url: 'http://PLACEHOLDER/dwproton-11.0-14-x86_64.tar.xz'
      },
      {
        name: 'dwproton-11.0-14-x86_64.tar.xz.torrent',
        browser_download_url: 'http://PLACEHOLDER/dwproton-11.0-14-x86_64.tar.xz.torrent'
      }
    ]
  }
]

let server: Server
let baseUrl: string

const FIXTURE_TARBALL_CONTENT = Buffer.from('fake dwproton tarball bytes')
const SHA512_OF_FIXTURE = createHash('sha512').update(FIXTURE_TARBALL_CONTENT).digest('hex')

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/releases') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(SAMPLE_RELEASES).replace(/http:\/\/PLACEHOLDER/g, baseUrl))
      return
    }
    if (req.url === '/empty-releases') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('[]')
      return
    }
    if (req.url === '/good.sha512sum') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`${SHA512_OF_FIXTURE}  dwproton.tar.xz\n`)
      return
    }
    if (req.url === '/bad.sha512sum') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(`${'0'.repeat(128)}  dwproton.tar.xz\n`)
      return
    }
    // Anything else (e.g. /unreachable) simulates the API being down.
    res.writeHead(500)
    res.end('internal error')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => server.close())

describe('fetchLatestDWProtonRelease', () => {
  it('picks the x86_64 tarball and sha512sum assets from the latest release', async () => {
    const got = await fetchLatestDWProtonRelease(`${baseUrl}/releases`)
    expect(got.tagName).toBe('dwproton-11.0-14')
    expect(got.downloadUrl).toBe(`${baseUrl}/dwproton-11.0-14-x86_64.tar.xz`)
    expect(got.sha512sumUrl).toBe(`${baseUrl}/dwproton-11.0-14-x86_64.sha512sum`)
  })

  it('throws a clear error on an HTTP failure, instead of hanging or crashing the launcher', async () => {
    await expect(fetchLatestDWProtonRelease(`${baseUrl}/unreachable`)).rejects.toThrow(/HTTP 500/)
  })

  it('throws a clear error when there are no releases at all', async () => {
    await expect(fetchLatestDWProtonRelease(`${baseUrl}/empty-releases`)).rejects.toThrow(/no dwproton releases/i)
  })
})

let tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-linux-launcher-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('isDWProtonInstalled', () => {
  it('is false when the proton binary is not present', async () => {
    const baseDir = await makeTempDir()
    expect(await isDWProtonInstalled(baseDir, 'dwproton-11.0-14')).toBe(false)
  })

  it('is true once the proton binary exists at the expected path', async () => {
    const baseDir = await makeTempDir()
    const installDir = dwprotonInstallDir(baseDir, 'dwproton-11.0-14')
    await mkdir(installDir, { recursive: true })
    await writeFile(join(installDir, 'proton'), '#!/bin/sh\n')
    expect(await isDWProtonInstalled(baseDir, 'dwproton-11.0-14')).toBe(true)
  })
})

describe('extractDWProtonTarball', () => {
  it('extracts a tarball whose contents are wrapped in one top-level directory, stripping it', async () => {
    const dir = await makeTempDir()
    const srcDir = join(dir, 'src')
    await mkdir(join(srcDir, 'dwproton-11.0-14'), { recursive: true })
    await writeFile(join(srcDir, 'dwproton-11.0-14', 'proton'), '#!/bin/sh\n')
    const tarballPath = join(dir, 'dwproton-11.0-14-x86_64.tar.xz')

    await execFileAsync('tar', ['cJf', tarballPath, '-C', srcDir, 'dwproton-11.0-14'])

    const destDir = join(dir, 'dest')
    await extractDWProtonTarball(tarballPath, destDir)

    await expect(access(join(destDir, 'proton'))).resolves.toBeUndefined()
  })

  it('leaves no partial directory at destDir when tar extraction fails', async () => {
    const dir = await makeTempDir()
    const badTarballPath = join(dir, 'not-a-real-tarball.tar.xz')
    await writeFile(badTarballPath, 'this is not a valid tarball')

    const destDir = join(dir, 'dest')
    await expect(extractDWProtonTarball(badTarballPath, destDir)).rejects.toThrow()

    // Neither the final dir nor a leftover temp staging dir should exist.
    await expect(access(destDir)).rejects.toThrow()
    const siblingEntries = await readdir(dir)
    const leftoverTmp = siblingEntries.filter((e) => e.startsWith('dest.extracting-'))
    expect(leftoverTmp).toEqual([])
  })

  it('replaces a previously-installed destDir atomically on re-extraction', async () => {
    const dir = await makeTempDir()
    const srcDir = join(dir, 'src')
    await mkdir(join(srcDir, 'dwproton-new'), { recursive: true })
    await writeFile(join(srcDir, 'dwproton-new', 'proton'), '#!/bin/sh\necho new\n')
    const tarballPath = join(dir, 'dwproton-new-x86_64.tar.xz')
    await execFileAsync('tar', ['cJf', tarballPath, '-C', srcDir, 'dwproton-new'])

    const destDir = join(dir, 'dest')
    await mkdir(destDir, { recursive: true })
    await writeFile(join(destDir, 'proton'), '#!/bin/sh\necho old\n')
    await writeFile(join(destDir, 'stale-file'), 'should be gone after re-extraction')

    await extractDWProtonTarball(tarballPath, destDir)

    await expect(access(join(destDir, 'stale-file'))).rejects.toThrow()
    const got = await (await import('fs/promises')).readFile(join(destDir, 'proton'), 'utf-8')
    expect(got).toContain('new')
  })
})

describe('verifyTarballSha512', () => {
  let dir: string
  let tarballPath: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('succeeds when the downloaded tarball matches the published sha512sum', async () => {
    dir = await mkdtemp(join(tmpdir(), 'csore-sha512-test-'))
    tarballPath = join(dir, 'dwproton.tar.xz')
    await writeFile(tarballPath, FIXTURE_TARBALL_CONTENT)

    await expect(verifyTarballSha512(tarballPath, `${baseUrl}/good.sha512sum`)).resolves.toBeUndefined()
  })

  it('throws clearly when the tarball does not match the published sha512sum', async () => {
    dir = await mkdtemp(join(tmpdir(), 'csore-sha512-test-'))
    tarballPath = join(dir, 'dwproton.tar.xz')
    await writeFile(tarballPath, FIXTURE_TARBALL_CONTENT)

    await expect(verifyTarballSha512(tarballPath, `${baseUrl}/bad.sha512sum`)).rejects.toThrow(/sha512/i)
  })
})

describe('launchLinux', () => {
  it('rejects with a clear "not installed" message when umu-run is missing (ENOENT)', async () => {
    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn(() => {
          const child = new EventEmitter() as EventEmitter & { unref: () => void }
          child.unref = () => {}
          setImmediate(() => {
            const err = Object.assign(new Error('spawn umu-run ENOENT'), { code: 'ENOENT' })
            child.emit('error', err)
          })
          return child
        })
      }
    })

    const { launchLinux: launchLinuxMocked } = await import('./linux')
    await expect(
      launchLinuxMocked('/fake/proton', '/fake/prefix', '/fake/Bin/cstrike-online.exe', [])
    ).rejects.toThrow(/umu-launcher is not installed/i)

    vi.doUnmock('child_process')
    vi.resetModules()
  })

  it('rejects with a generic message for a non-ENOENT spawn error', async () => {
    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn(() => {
          const child = new EventEmitter() as EventEmitter & { unref: () => void }
          child.unref = () => {}
          setImmediate(() => child.emit('error', new Error('EACCES: permission denied')))
          return child
        })
      }
    })

    const { launchLinux: launchLinuxMocked } = await import('./linux')
    await expect(
      launchLinuxMocked('/fake/proton', '/fake/prefix', '/fake/Bin/cstrike-online.exe', [])
    ).rejects.toThrow(/EACCES/)

    vi.doUnmock('child_process')
    vi.resetModules()
  })
})
