
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, rm, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import AdmZip from 'adm-zip'

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

const GAME_FILE_CONTENT = Buffer.from('fake game executable bytes, representative of a real client file')
const AUDIO_FILE_CONTENT = Buffer.from(
  'fake voice-pack audio bytes, deliberately padded out further so the slow stream has plenty of room to be paused mid-transfer without finishing too quickly for the test to catch it'
)

function buildGameZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('Data/file.txt', GAME_FILE_CONTENT)
  return zip.toBuffer()
}

function buildAudioZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('Audio/voice_en.bin', AUDIO_FILE_CONTENT)
  return zip.toBuffer()
}

const GAME_ZIP = buildGameZip()
const GAME_ZIP_MD5 = md5(GAME_ZIP)
const AUDIO_ZIP = buildAudioZip()
const AUDIO_ZIP_MD5 = md5(AUDIO_ZIP)

let server: Server
let baseUrl: string
let gameFreshRequestCount = 0

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
                        url: `${baseUrl}/game-part`,
                        md5: GAME_ZIP_MD5,
                        size: String(GAME_ZIP.length),
                        decompressed_size: String(GAME_ZIP.length)
                      }
                    ],
                    audio_pkgs: [
                      {
                        url: `${baseUrl}/slow-audio-part`,
                        md5: AUDIO_ZIP_MD5,
                        size: String(AUDIO_ZIP.length),
                        decompressed_size: String(AUDIO_ZIP.length),
                        language: 'en'
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

    // Honor Range requests to exercise real download resume.
    if (req.url === '/game-part') {
      const range = req.headers.range
      if (range) {
        const match = /^bytes=(\d+)-$/.exec(range)
        const start = match ? parseInt(match[1], 10) : 0
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${GAME_ZIP.length - 1}/${GAME_ZIP.length}`,
          'Content-Length': String(GAME_ZIP.length - start)
        })
        res.end(GAME_ZIP.subarray(start))
        return
      }
      gameFreshRequestCount++
      res.writeHead(200, { 'Content-Length': String(GAME_ZIP.length) })
      res.end(GAME_ZIP)
      return
    }

    if (req.url === '/slow-audio-part') {
      const range = req.headers.range
      if (range) {
        const match = /^bytes=(\d+)-$/.exec(range)
        const start = match ? parseInt(match[1], 10) : 0
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${AUDIO_ZIP.length - 1}/${AUDIO_ZIP.length}`,
          'Content-Length': String(AUDIO_ZIP.length - start)
        })
        res.end(AUDIO_ZIP.subarray(start))
        return
      }

      res.writeHead(200, { 'Content-Length': String(AUDIO_ZIP.length) })
      const step = 30
      let offset = 0
      const sendNext = (): void => {
        if (offset >= AUDIO_ZIP.length || res.writableEnded) {
          res.end()
          return
        }
        const slice = AUDIO_ZIP.subarray(offset, offset + step)
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

describe('fresh install: pausing mid-AUDIO-phase, resuming genuinely re-exercises the GAME part resume without colliding (Finding E / I1)', () => {
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
    gameFreshRequestCount = 0
  })

  it('leaves a complete GAME part and a partial AUDIO part coexisting in partsDir without corruption, and completes correctly on resume', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-freshaudiopause-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-freshaudiopause-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-freshaudiopause-'))
    mockTempDir.current = tempDir

    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const url = new URL(urlString)
      if (url.hostname === 'sg-csore-api.serenetia.com') {
        const rewritten = new URL(baseUrl)
        url.protocol = rewritten.protocol
        url.hostname = rewritten.hostname
        url.port = rewritten.port
        return originalFetch(url.toString(), init)
      }
      return originalFetch(urlString, init)
    }) as unknown as typeof fetch

    const { performInstallOrUpdate, pauseCurrentOperation, isOperationInProgress } = await import('./gameManager')

    const installPromise = performInstallOrUpdate(installDir, () => {})

    await new Promise((r) => setTimeout(r, 150))
    expect(isOperationInProgress()).toBe(true)

    const paused = pauseCurrentOperation()
    expect(paused).toBe(true)
    await expect(installPromise).resolves.toEqual({ status: 'paused' })
    expect(isOperationInProgress()).toBe(false)

    const dataAfterPause = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(dataAfterPause.equals(GAME_FILE_CONTENT)).toBe(true)

    await expect(readFile(join(installDir, 'Audio', 'voice_en.bin'))).rejects.toThrow()

    const partsDir = join(tempDir, 'csore-launcher-parts')
    const gamePartStat = await stat(join(partsDir, `part-${GAME_ZIP_MD5}`))
    expect(gamePartStat.size).toBe(GAME_ZIP.length)
    const audioPartStat = await stat(join(partsDir, `part-${AUDIO_ZIP_MD5}`))
    expect(audioPartStat.size).toBeGreaterThan(0)
    expect(audioPartStat.size).toBeLessThan(AUDIO_ZIP.length)

    expect(gameFreshRequestCount).toBe(1)

    const progress: { phase: string }[] = []
    const resumeResult = await performInstallOrUpdate(installDir, (u) => progress.push(u))
    expect(resumeResult).toEqual({ status: 'completed' })
    expect(progress.some((u) => u.phase === 'downloading_audio')).toBe(true)

    expect(gameFreshRequestCount).toBe(1)

    const dataAfterResume = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(dataAfterResume.equals(GAME_FILE_CONTENT)).toBe(true)
    const audioAfterResume = await readFile(join(installDir, 'Audio', 'voice_en.bin'))
    expect(audioAfterResume.equals(AUDIO_FILE_CONTENT)).toBe(true)

    const { readInstallState } = await import('./installState')
    const finalState = await readInstallState(installDir)
    expect(finalState?.version).toBe('1.0.0')
  }, 20_000)
})
