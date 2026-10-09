import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, rm, mkdir, access, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  fetchLatestDWProtonRelease,
  dwprotonInstallDir,
  isDWProtonInstalled,
  extractDWProtonTarball
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
})
