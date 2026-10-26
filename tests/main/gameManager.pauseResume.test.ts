import { readInstallState } from '../../src/main/installState'

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, rm, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
import AdmZip from 'adm-zip'

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

const EXE_CONTENT = randomBytes(20_000)
const DATA_CONTENT = Buffer.from('fake data file')

function buildClientZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('Bin/cstrike-online.exe', EXE_CONTENT)
  zip.addFile('Data/file.txt', DATA_CONTENT)
  return zip.toBuffer()
}

const CLIENT_ZIP = buildClientZip()
const CLIENT_ZIP_MD5 = md5(CLIENT_ZIP)

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/launcher_info')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          retcode: 0,
          message: 'OK',
          data: {
            game_packages: [
              {
                game: { id: '1', biz: 'csore_global' },
                main: {
                  major: {
                    version: '1.0.0',
                    game_pkgs: [
                      {
                        url: `${baseUrl}/slow-part`,
                        md5: CLIENT_ZIP_MD5,
                        size: String(CLIENT_ZIP.length),
                        decompressed_size: String(CLIENT_ZIP.length)
                      }
                    ],
                    res_list_url: ''
                  },
                  patches: [],
                  required_client_version: '1.0.0'
                }
              }
            ]
          }
        })
      )
      return
    }

    if (req.url === '/slow-part') {
      const range = req.headers.range
      if (range) {
        const match = /^bytes=(\d+)-$/.exec(range)
        const start = match ? parseInt(match[1], 10) : 0
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${CLIENT_ZIP.length - 1}/${CLIENT_ZIP.length}`,
          'Content-Length': String(CLIENT_ZIP.length - start)
        })
        res.end(CLIENT_ZIP.subarray(start))
        return
      }

      // Fresh request: stream slowly in small steps so the test can pause
      // mid-transfer.
      res.writeHead(200, { 'Content-Length': String(CLIENT_ZIP.length) })
      const step = 1000
      let offset = 0
      const sendNext = (): void => {
        if (offset >= CLIENT_ZIP.length || res.writableEnded) {
          res.end()
          return
        }
        const slice = CLIENT_ZIP.subarray(offset, offset + step)
        offset += step
        res.write(slice, () => setTimeout(sendNext, 20))
      }
      sendNext()
      return
    }

    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => server.close())

const mockUserDataDir = { current: '' }
const mockTempDir = { current: '' }
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataDir.current
      if (name === 'temp') return mockTempDir.current
      return `/mock/${name}`
    }
  }
}))

describe('pause/resume (real local-server download)', () => {
  let userDataDir: string
  let installDir: string
  let tempDir: string
  let originalFetch: typeof fetch

  afterEach(async () => {
    global.fetch = originalFetch
    vi.resetModules()
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
    await rm(tempDir, { recursive: true, force: true })
  })

  it('pausing mid-download leaves the partial part file intact, resolves { status: "paused" }, and frees operationInProgress', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-pause-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-pause-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-pause-'))
    mockTempDir.current = tempDir

    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(urlString)
      if (url.hostname === 'sg-tia-api.serenetia.com') {
        const rewritten = new URL(baseUrl)
        url.protocol = rewritten.protocol
        url.hostname = rewritten.hostname
        url.port = rewritten.port
        return originalFetch(url.toString(), init)
      }
      return originalFetch(urlString, init)
    }) as unknown as typeof fetch

    const { performInstallOrUpdate, pauseCurrentOperation, isOperationInProgress } = await import('../../src/main/gameManager')

    const installPromise = performInstallOrUpdate(installDir, () => {})

    await vi.waitFor(async () => {
      const file = await stat(join(installDir, '.csore_download_tmp', 'parts', `part-${CLIENT_ZIP_MD5}`))
      expect(file.size).toBeGreaterThan(0)
      expect(file.size).toBeLessThan(CLIENT_ZIP.length)
    }, { interval: 10, timeout: 3000 })
    expect(isOperationInProgress()).toBe(true)

    const paused = pauseCurrentOperation()
    expect(paused).toBe(true)

    await expect(installPromise).resolves.toEqual({ status: 'paused' })

    expect(isOperationInProgress()).toBe(false)

    const partPath = join(installDir, '.csore_download_tmp', 'parts', `part-${CLIENT_ZIP_MD5}`)
    const partStat = await stat(partPath)
    expect(partStat.size).toBeGreaterThan(0)
    expect(partStat.size).toBeLessThan(CLIENT_ZIP.length)

    expect(await readInstallState(installDir)).toBeNull()

    expect(pauseCurrentOperation()).toBe(false)

    // ---- Resume: simply call performInstallOrUpdate again ----
    const progress: unknown[] = []
    const resumeResult = await performInstallOrUpdate(installDir, (u) => progress.push(u))
    expect(resumeResult).toEqual({ status: 'completed' })

    expect(progress.length).toBeGreaterThan(0)
    const exeAfterResume = await readFile(join(installDir, 'Bin', 'cstrike-online.exe'))
    expect(exeAfterResume.equals(EXE_CONTENT)).toBe(true)
    const dataAfterResume = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(dataAfterResume.equals(DATA_CONTENT)).toBe(true)
    const state = (await readInstallState(installDir))!
    expect(state.version).toBe('1.0.0')
  }, 15_000)

  it('refuses a second performInstallOrUpdate call while one is already in progress', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-reentrant-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-reentrant-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-reentrant-'))
    mockTempDir.current = tempDir

    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(urlString)
      if (url.hostname === 'sg-tia-api.serenetia.com') {
        const rewritten = new URL(baseUrl)
        url.protocol = rewritten.protocol
        url.hostname = rewritten.hostname
        url.port = rewritten.port
        return originalFetch(url.toString(), init)
      }
      return originalFetch(urlString, init)
    }) as unknown as typeof fetch

    const { performInstallOrUpdate, pauseCurrentOperation } = await import('../../src/main/gameManager')

    const firstCall = performInstallOrUpdate(installDir, () => {})
    await expect(performInstallOrUpdate(installDir, () => {})).rejects.toThrow(/already in progress/i)

    pauseCurrentOperation()
    await expect(firstCall).resolves.toEqual({ status: 'paused' })
  }, 15_000)
})
