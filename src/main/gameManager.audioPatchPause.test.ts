
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import AdmZip from 'adm-zip'

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

const DATA_FILE_V1 = Buffer.from('fake data file v1')
const DELTA_SUFFIX = Buffer.from(' plus v1.1 patch suffix')
const DATA_FILE_V2 = Buffer.concat([DATA_FILE_V1, DELTA_SUFFIX])

const AUDIO_FILE_V1 = Buffer.from('fake voice-pack audio bytes v1, needs to be long enough to stream in steps')
const AUDIO_SUFFIX = Buffer.from(' plus v1.1 audio patch suffix, also padded out a bit so the slow stream has room')
const AUDIO_FILE_V2 = Buffer.concat([AUDIO_FILE_V1, AUDIO_SUFFIX])

function buildGamePatchZip(): Buffer {
  const zip = new AdmZip()
  const manifest = {
    entries: [
      {
        path: 'Data/file.txt',
        action: 'modified',
        delta_file: 'deltas/0001.fake',
        old_md5: md5(DATA_FILE_V1),
        new_md5: md5(DATA_FILE_V2)
      }
    ]
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('deltas/0001.fake', DELTA_SUFFIX)
  return zip.toBuffer()
}

function buildAudioPatchZip(): Buffer {
  const zip = new AdmZip()
  const manifest = {
    entries: [
      {
        path: 'Audio/voice_en.bin',
        action: 'modified',
        delta_file: 'deltas/audio-0001.fake',
        old_md5: md5(AUDIO_FILE_V1),
        new_md5: md5(AUDIO_FILE_V2)
      }
    ]
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('deltas/audio-0001.fake', AUDIO_SUFFIX)
  return zip.toBuffer()
}

const GAME_PATCH_ZIP = buildGamePatchZip()
const GAME_PATCH_ZIP_MD5 = md5(GAME_PATCH_ZIP)
const AUDIO_PATCH_ZIP = buildAudioPatchZip()
const AUDIO_PATCH_ZIP_MD5 = md5(AUDIO_PATCH_ZIP)

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
                    version: '1.1.0',
                    game_pkgs: [
                      { url: `${baseUrl}/unserved-full-client`, md5: 'deadbeef', size: '1', decompressed_size: '1' }
                    ],
                    res_list_url: ''
                  },
                  patches: [
                    {
                      version: '1.0.0',
                      game_pkgs: [
                        {
                          url: `${baseUrl}/game-patch-part`,
                          md5: GAME_PATCH_ZIP_MD5,
                          size: String(GAME_PATCH_ZIP.length),
                          decompressed_size: String(GAME_PATCH_ZIP.length)
                        }
                      ],
                      audio_pkgs: [
                        {
                          url: `${baseUrl}/slow-audio-patch-part`,
                          md5: AUDIO_PATCH_ZIP_MD5,
                          size: String(AUDIO_PATCH_ZIP.length),
                          decompressed_size: String(AUDIO_PATCH_ZIP.length),
                          language: 'en'
                        }
                      ],
                      res_list_url: ''
                    }
                  ],
                  required_client_version: '1.0.0'
                }
              }
            ]
          }
        })
      )
      return
    }

    if (req.url === '/game-patch-part') {
      res.writeHead(200, { 'Content-Length': String(GAME_PATCH_ZIP.length) })
      res.end(GAME_PATCH_ZIP)
      return
    }

    if (req.url === '/slow-audio-patch-part') {
      const range = req.headers.range
      if (range) {
        const match = /^bytes=(\d+)-$/.exec(range)
        const start = match ? parseInt(match[1], 10) : 0
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${AUDIO_PATCH_ZIP.length - 1}/${AUDIO_PATCH_ZIP.length}`,
          'Content-Length': String(AUDIO_PATCH_ZIP.length - start)
        })
        res.end(AUDIO_PATCH_ZIP.subarray(start))
        return
      }

      res.writeHead(200, { 'Content-Length': String(AUDIO_PATCH_ZIP.length) })
      const step = 40
      let offset = 0
      const sendNext = (): void => {
        if (offset >= AUDIO_PATCH_ZIP.length || res.writableEnded) {
          res.end()
          return
        }
        const slice = AUDIO_PATCH_ZIP.subarray(offset, offset + step)
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

vi.mock('./bsdiffAdapter', () => ({
  bspatch: async (oldFile: Buffer, delta: Buffer): Promise<Buffer> => Buffer.concat([oldFile, delta])
}))

describe('pausing mid-audio-patch-download', () => {
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

  it('commits the game-patch side immediately, then resumes to finish only the audio patch -- no spurious MD5 failure, no fallback to fresh install', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-audiopause-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-audiopause-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-audiopause-'))
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

    await mkdir(join(installDir, 'Data'), { recursive: true })
    await mkdir(join(installDir, 'Audio'), { recursive: true })
    await writeFile(join(installDir, 'Data', 'file.txt'), DATA_FILE_V1)
    await writeFile(join(installDir, 'Audio', 'voice_en.bin'), AUDIO_FILE_V1)
    const { writeInstallState } = await import('./installState')
    await writeInstallState(installDir, {
      version: '1.0.0',
      installDir,
      files: [
        { path: 'Data/file.txt', md5: md5(DATA_FILE_V1) },
        { path: 'Audio/voice_en.bin', md5: md5(AUDIO_FILE_V1) }
      ]
    })

    const { performInstallOrUpdate, pauseCurrentOperation, isOperationInProgress } = await import('./gameManager')

    const updatePromise = performInstallOrUpdate(installDir, () => {})

    // Let the slow audio-patch stream deliver a few chunks before pausing.
    await new Promise((r) => setTimeout(r, 150))
    expect(isOperationInProgress()).toBe(true)

    const paused = pauseCurrentOperation()
    expect(paused).toBe(true)
    await expect(updatePromise).resolves.toEqual({ status: 'paused' })
    expect(isOperationInProgress()).toBe(false)

    const { readInstallState } = await import('./installState')
    const midState = await readInstallState(installDir)
    expect(midState?.version).toBe('1.1.0')
    const dataAfterPause = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(dataAfterPause.equals(DATA_FILE_V2)).toBe(true)

    const audioAfterPause = await readFile(join(installDir, 'Audio', 'voice_en.bin'))
    expect(audioAfterPause.equals(AUDIO_FILE_V1)).toBe(true)

    // ---- Resume: simply call performInstallOrUpdate again.
    const progress: { phase: string }[] = []
    const resumeResult = await performInstallOrUpdate(installDir, (u) => progress.push(u))
    expect(resumeResult).toEqual({ status: 'completed' })
    expect(progress.some((u) => u.phase === 'downloading_audio')).toBe(true)

    const audioAfterResume = await readFile(join(installDir, 'Audio', 'voice_en.bin'))
    expect(audioAfterResume.equals(AUDIO_FILE_V2)).toBe(true)
    // Game patch's own effect (committed before the pause) survives
    // untouched across the resume.
    const dataAfterResume = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(dataAfterResume.equals(DATA_FILE_V2)).toBe(true)

    const finalState = await readInstallState(installDir)
    expect(finalState?.version).toBe('1.1.0')
    const audioEntry = finalState?.files.find((f) => f.path === 'Audio/voice_en.bin')
    expect(audioEntry?.md5).toBe(md5(AUDIO_FILE_V2))

    const { readPendingAudioPatch } = await import('./installState')
    expect(await readPendingAudioPatch(installDir)).toBeNull()
  }, 15_000)
})
