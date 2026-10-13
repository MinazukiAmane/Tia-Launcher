
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { readFileSync, writeFileSync } from 'fs'
import { mkdtemp, rm, readFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import AdmZip from 'adm-zip'

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

// --- Build the fixture "client" zip (fresh install, version 1.0.0) ---
const EXE_CONTENT_V1 = readFileSync(join(process.cwd(), 'src/main/launcher/fixtures/flags-fixture-x86.exe'))
const DATA_FILE_V1 = Buffer.from('fake data file v1')

function buildClientZip(exeContent: Buffer, dataContent: Buffer): Buffer {
  const zip = new AdmZip()
  zip.addFile('Bin/cstrike-online.exe', exeContent)
  zip.addFile('Data/file.txt', dataContent)
  return zip.toBuffer()
}

const DELTA_SUFFIX = Buffer.from(' plus v1.1 patch suffix')
const DATA_FILE_V2 = Buffer.concat([DATA_FILE_V1, DELTA_SUFFIX])
const NEW_FILE_V2 = Buffer.from('brand new file added in 1.1.0')

function buildPatchZip(): Buffer {
  const zip = new AdmZip()
  const manifest = {
    entries: [
      {
        path: 'Data/file.txt',
        action: 'modified',
        delta_file: 'deltas/0001.fake',
        old_md5: md5(DATA_FILE_V1),
        new_md5: md5(DATA_FILE_V2)
      },
      {
        path: 'Data/new.txt',
        action: 'added',
        new_md5: md5(NEW_FILE_V2),
        size: NEW_FILE_V2.length
      }
    ]
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('deltas/0001.fake', DELTA_SUFFIX)
  zip.addFile('Data/new.txt', NEW_FILE_V2)
  return zip.toBuffer()
}

function splitIntoParts(
  buf: Buffer,
  n: number,
  baseUrl: string,
  prefix: string
): { parts: { url: string; md5: string; size: string; decompressed_size: string }[]; bytesByPath: Map<string, Buffer> } {
  const chunkSize = Math.ceil(buf.length / n)
  const bytesByPath = new Map<string, Buffer>()
  const parts: { url: string; md5: string; size: string; decompressed_size: string }[] = []
  for (let i = 0; i < n; i++) {
    const chunk = buf.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buf.length))
    if (chunk.length === 0) continue
    const path = `/${prefix}-${i}`
    bytesByPath.set(path, chunk)
    parts.push({
      url: `${baseUrl}${path}`,
      md5: md5(chunk),
      size: String(chunk.length),
      decompressed_size: String(chunk.length)
    })
  }
  return { parts, bytesByPath }
}

let server: Server
let baseUrl: string
let servedFiles: Map<string, Buffer>
let launcherInfoResponse: unknown

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/launcher_info')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(launcherInfoResponse))
      return
    }
    const path = req.url?.split('?')[0] ?? ''
    const bytes = servedFiles.get(path)
    if (bytes) {
      res.writeHead(200, { 'Content-Length': String(bytes.length) })
      res.end(bytes)
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

describe('install -> patch -> launch integration', () => {
  let userDataDir: string
  let installDir: string
  let tempDir: string
  let originalFetch: typeof fetch

  afterEach(async () => {
    vi.doUnmock('child_process')
    vi.resetModules()
    global.fetch = originalFetch
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
    await rm(tempDir, { recursive: true, force: true })
  })

  it('installs fresh, applies a patch, and launches, with real reassembleParts/applyPatch/launch code throughout', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-integration-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-integration-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-integration-'))
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

    // ---- Step 1: fresh install at version 1.0.0 ----
    const clientZipV1 = buildClientZip(EXE_CONTENT_V1, DATA_FILE_V1)
    const { parts: freshParts, bytesByPath: freshBytes } = splitIntoParts(clientZipV1, 2, baseUrl, 'fresh-part')
    servedFiles = freshBytes

    launcherInfoResponse = {
      retcode: 0,
      message: 'OK',
      data: {
        game_packages: [
          {
            game: { id: '1', biz: 'csore_global' },
            main: {
              major: { version: '1.0.0', game_pkgs: freshParts, res_list_url: '' },
              patches: [],
              required_client_version: '1.0.0'
            }
          }
        ]
      }
    }

    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return { ...actual, spawn: vi.fn() }
    })

    const progress1: unknown[] = []
    const { performInstallOrUpdate: install1 } = await import('./gameManager')
    await install1(installDir, (u) => progress1.push(u))

    expect(progress1.length).toBeGreaterThan(0)
    const exeAfterInstall = await readFile(join(installDir, 'Bin', 'cstrike-online.exe'))
    expect(exeAfterInstall.equals(EXE_CONTENT_V1)).toBe(true)
    const dataAfterInstall = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(dataAfterInstall.equals(DATA_FILE_V1)).toBe(true)
    const stateAfterInstall = JSON.parse(await readFile(join(installDir, '.csore_install.json'), 'utf-8'))
    expect(stateAfterInstall.version).toBe('1.0.0')

    // ---- Step 2: version bump to 1.1.0, apply a patch ----
    const patchZip = buildPatchZip()
    const { parts: patchParts, bytesByPath: patchBytes } = splitIntoParts(patchZip, 2, baseUrl, 'patch-part')
    servedFiles = patchBytes

    launcherInfoResponse = {
      retcode: 0,
      message: 'OK',
      data: {
        game_packages: [
          {
            game: { id: '1', biz: 'csore_global' },
            main: {
              major: { version: '1.1.0', game_pkgs: freshParts, res_list_url: '' },
              patches: [{ version: '1.0.0', game_pkgs: patchParts, res_list_url: '' }],
              required_client_version: '1.0.0'
            }
          }
        ]
      }
    }

    const progress2: unknown[] = []
    const { performInstallOrUpdate: install2 } = await import('./gameManager')
    await install2(installDir, (u) => progress2.push(u))

    expect(progress2.length).toBeGreaterThan(0)
    const dataAfterPatch = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(dataAfterPatch.equals(DATA_FILE_V2)).toBe(true)
    const newFileAfterPatch = await readFile(join(installDir, 'Data', 'new.txt'))
    expect(newFileAfterPatch.equals(NEW_FILE_V2)).toBe(true)
    // Original exe untouched by the patch (not mentioned in its manifest).
    const exeAfterPatch = await readFile(join(installDir, 'Bin', 'cstrike-online.exe'))
    expect(exeAfterPatch.equals(EXE_CONTENT_V1)).toBe(true)
    const stateAfterPatch = JSON.parse(await readFile(join(installDir, '.csore_install.json'), 'utf-8'))
    expect(stateAfterPatch.version).toBe('1.1.0')

    const progress3: unknown[] = []
    const { performInstallOrUpdate: install3 } = await import('./gameManager')
    await install3(installDir, (u) => progress3.push(u))
    expect(progress3).toEqual([])

    // ---- Step 3: launch, via the real selectLaunchFn/findGameExecutable code ----
    const spawnCalls: unknown[][] = []
    vi.doUnmock('child_process')
    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn((...args: unknown[]) => {
          spawnCalls.push(args)
          // Simulate only the native process boundary acknowledging initialization.
          const reportArg = (args[1] as string[])[0]
          const report = process.platform === 'win32' ? reportArg : reportArg.slice(2).replace(/\\/g, '/')
          writeFileSync(report, 'ready\nflags_before_resume: 1\n')
          const child = new EventEmitter() as EventEmitter & { unref: () => void }
          child.unref = () => {}
          setImmediate(() => child.emit('spawn'))
          return child
        })
      }
    })

    const { selectLaunchFn } = await import('./gameManager')
    const launch = selectLaunchFn('win32')
    await expect(launch(installDir, ['-console'])).resolves.toBeUndefined()

    expect(spawnCalls).toHaveLength(1)
    const [exePathArg, argsArg, optsArg] = spawnCalls[0] as [string, string[], { cwd: string }]
    expect(exePathArg).toBe(join(process.cwd(), 'build/native/flag-launch-x86.exe'))
    const clientArg = process.platform === 'win32' ? join(installDir, 'Bin', 'cstrike-online.exe') : 'Z:' + join(installDir, 'Bin', 'cstrike-online.exe').replace(/\//g, '\\')
    expect(argsArg.slice(1)).toEqual([clientArg, '-console'])
    expect(optsArg.cwd).toBe(join(installDir, 'Bin'))
  })
})

const AUDIO_FILE_V1 = Buffer.from('fake voice-pack audio bytes v1')
const AUDIO_SUFFIX = Buffer.from(' plus v1.1 audio patch suffix')
const AUDIO_FILE_V2 = Buffer.concat([AUDIO_FILE_V1, AUDIO_SUFFIX])

function buildAudioFreshZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('Audio/voice_en.bin', AUDIO_FILE_V1)
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

describe('audio_pkgs[] download + install/patch (spec gap)', () => {
  let userDataDir: string
  let installDir: string
  let tempDir: string
  let originalFetch: typeof fetch

  afterEach(async () => {
    vi.resetModules()
    global.fetch = originalFetch
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
    await rm(tempDir, { recursive: true, force: true })
  })

  it('downloads and extracts audio_pkgs on fresh install, then downloads and applies an audio patch on update, recording both in InstallState.files', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-audio-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-audio-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-audio-'))
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

    // ---- Fresh install at 1.0.0, WITH audio_pkgs present ----
    const clientZipV1 = buildClientZip(EXE_CONTENT_V1, DATA_FILE_V1)
    const { parts: freshParts, bytesByPath: freshBytes } = splitIntoParts(clientZipV1, 2, baseUrl, 'audio-fresh-part')
    const audioZipV1 = buildAudioFreshZip()
    const { parts: audioFreshParts, bytesByPath: audioFreshBytes } = splitIntoParts(
      audioZipV1,
      1,
      baseUrl,
      'audio-fresh-audio-part'
    )
    servedFiles = new Map([...freshBytes, ...audioFreshBytes])

    launcherInfoResponse = {
      retcode: 0,
      message: 'OK',
      data: {
        game_packages: [
          {
            game: { id: '1', biz: 'csore_global' },
            main: {
              major: {
                version: '1.0.0',
                game_pkgs: freshParts,
                audio_pkgs: audioFreshParts.map((p) => ({ ...p, language: 'en' })),
                res_list_url: ''
              },
              patches: [],
              required_client_version: '1.0.0'
            }
          }
        ]
      }
    }

    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return { ...actual, spawn: vi.fn() }
    })

    const progress1: { phase: string }[] = []
    const { performInstallOrUpdate: install1 } = await import('./gameManager')
    await install1(installDir, (u) => progress1.push(u))

    const audioAfterInstall = await readFile(join(installDir, 'Audio', 'voice_en.bin'))
    expect(audioAfterInstall.equals(AUDIO_FILE_V1)).toBe(true)
    expect(progress1.some((u) => u.phase === 'downloading_audio')).toBe(true)
    expect(progress1.some((u) => u.phase === 'extracting_audio')).toBe(true)

    const { readInstallState } = await import('./installState')
    const stateAfterInstall = await readInstallState(installDir)
    const pathsAfterInstall = stateAfterInstall?.files.map((f) => f.path) ?? []
    expect(pathsAfterInstall).toEqual(
      expect.arrayContaining(['Bin/cstrike-online.exe', 'Data/file.txt', 'Audio/voice_en.bin'])
    )
    const audioEntryAfterInstall = stateAfterInstall?.files.find((f) => f.path === 'Audio/voice_en.bin')
    expect(audioEntryAfterInstall?.md5).toBe(md5(AUDIO_FILE_V1))

    // ---- Update to 1.1.0: game patch + an independent audio patch ----
    const patchZip = buildPatchZip()
    const { parts: patchParts, bytesByPath: patchBytes } = splitIntoParts(patchZip, 1, baseUrl, 'audio-game-patch-part')
    const audioPatchZip = buildAudioPatchZip()
    const { parts: audioPatchParts, bytesByPath: audioPatchBytes } = splitIntoParts(
      audioPatchZip,
      1,
      baseUrl,
      'audio-patch-part'
    )
    servedFiles = new Map([...patchBytes, ...audioPatchBytes])

    launcherInfoResponse = {
      retcode: 0,
      message: 'OK',
      data: {
        game_packages: [
          {
            game: { id: '1', biz: 'csore_global' },
            main: {
              major: {
                version: '1.1.0',
                game_pkgs: freshParts,
                audio_pkgs: audioFreshParts.map((p) => ({ ...p, language: 'en' })),
                res_list_url: ''
              },
              patches: [
                {
                  version: '1.0.0',
                  game_pkgs: patchParts,
                  audio_pkgs: audioPatchParts.map((p) => ({ ...p, language: 'en' })),
                  res_list_url: ''
                }
              ],
              required_client_version: '1.0.0'
            }
          }
        ]
      }
    }

    const progress2: { phase: string }[] = []
    const { performInstallOrUpdate: install2 } = await import('./gameManager')
    await install2(installDir, (u) => progress2.push(u))

    const audioAfterPatch = await readFile(join(installDir, 'Audio', 'voice_en.bin'))
    expect(audioAfterPatch.equals(AUDIO_FILE_V2)).toBe(true)
    expect(progress2.some((u) => u.phase === 'downloading_audio')).toBe(true)

    const stateAfterPatch = await readInstallState(installDir)
    expect(stateAfterPatch?.version).toBe('1.1.0')
    const audioEntryAfterPatch = stateAfterPatch?.files.find((f) => f.path === 'Audio/voice_en.bin')
    expect(audioEntryAfterPatch?.md5).toBe(md5(AUDIO_FILE_V2))
    // Game patch's own file changes are still reflected alongside the audio ones.
    const dataEntryAfterPatch = stateAfterPatch?.files.find((f) => f.path === 'Data/new.txt')
    expect(dataEntryAfterPatch).toBeDefined()
  })
})

// Real HTTP repair restores damaged assets without fetching package parts.
describe('repairInstall (spec §6)', () => {
  let userDataDir: string
  let installDir: string
  let tempDir: string
  let originalFetch: typeof fetch

  afterEach(async () => {
    vi.resetModules()
    global.fetch = originalFetch
    await rm(userDataDir, { recursive: true, force: true })
    await rm(installDir, { recursive: true, force: true })
    await rm(tempDir, { recursive: true, force: true })
  })

  it('downloads only a corrupted file when the current state is up to date', async () => {
    originalFetch = global.fetch
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-repair-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-repair-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-repair-'))
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

    const clientZipV1 = buildClientZip(EXE_CONTENT_V1, DATA_FILE_V1)
    const { parts: freshParts, bytesByPath: freshBytes } = splitIntoParts(clientZipV1, 2, baseUrl, 'repair-fresh-part')
    servedFiles = freshBytes

    launcherInfoResponse = {
      retcode: 0,
      message: 'OK',
      data: {
        game_packages: [
          {
            game: { id: '1', biz: 'csore_global' },
            main: {
              major: { version: '1.0.0', game_pkgs: freshParts, res_list_url: '' },
              patches: [],
              required_client_version: '1.0.0'
            }
          }
        ]
      }
    }

    vi.resetModules()
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return { ...actual, spawn: vi.fn() }
    })

    const { performInstallOrUpdate } = await import('./gameManager')
    await performInstallOrUpdate(installDir, () => {})

    const { writeFile } = await import('fs/promises')
    await writeFile(join(installDir, 'Data', 'file.txt'), Buffer.from('corrupted!'))
    const noopProgress: unknown[] = []
    await performInstallOrUpdate(installDir, (u) => noopProgress.push(u))
    expect(noopProgress).toEqual([]) // confirms up_to_date was genuinely taken, not a repair

    const manifest = {
      version: '1.0.0', repair_supported: true,
      files: [
        { path: 'Bin/cstrike-online.exe', md5: md5(EXE_CONTENT_V1), size: EXE_CONTENT_V1.length, url: baseUrl + '/repair-exe' },
        { path: 'Data/file.txt', md5: md5(DATA_FILE_V1), size: DATA_FILE_V1.length, url: baseUrl + '/repair-data' },
        { path: 'Audio/voice.bin', md5: md5(Buffer.from('voice')), size: 5, url: baseUrl + '/repair-audio' }
      ]
    }
    servedFiles = new Map([
      ['/repair-manifest', Buffer.from(JSON.stringify(manifest))],
      ['/repair-data', DATA_FILE_V1],
      ['/repair-audio', Buffer.from('voice')]
    ])
    const major = (launcherInfoResponse as any).data.game_packages[0].main.major
    major.res_list_url = baseUrl + '/repair-manifest'
    const { repairInstall } = await import('./gameManager')
    const repairProgress: unknown[] = []
    await repairInstall(installDir, (u) => repairProgress.push(u))

    expect(repairProgress.length).toBeGreaterThan(0)
    const fixedFile = await readFile(join(installDir, 'Data', 'file.txt'))
    expect(fixedFile.equals(DATA_FILE_V1)).toBe(true)
    expect(await readFile(join(installDir, 'Audio', 'voice.bin'), 'utf8')).toBe('voice')
    expect((await readFile(join(installDir, 'Bin', 'cstrike-online.exe'))).equals(EXE_CONTENT_V1)).toBe(true)
    servedFiles.set('/repair-manifest', Buffer.from(JSON.stringify({ ...manifest, repair_supported: false })))
    await expect(repairInstall(installDir, () => {})).rejects.toThrow(/not available/i)
  })

  it('refuses to run while another operation is already in progress', async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-userdata-repair-race-'))
    mockUserDataDir.current = userDataDir
    installDir = await mkdtemp(join(tmpdir(), 'csore-install-repair-race-'))
    tempDir = await mkdtemp(join(tmpdir(), 'csore-temp-repair-race-'))
    mockTempDir.current = tempDir
    await mkdir(installDir, { recursive: true })

    vi.resetModules()
    const { repairInstall, uninstallGame } = await import('./gameManager')

    const firstCall = uninstallGame(installDir)
    await expect(repairInstall(installDir, () => {})).rejects.toThrow(/already in progress/i)
    await firstCall
  })
})
