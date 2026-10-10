
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { decideAction, reassembleParts } from './installManager'
import { DownloadPausedError } from './downloader'
import type { GamePackageEntry, PkgEntry } from './launcherApi'
import type { InstallState } from './installState'

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

function makeInfo(majorVersion: string, patches: Array<{ version: string }> = []): GamePackageEntry {
  return {
    game: { id: 'g', biz: 'csore_global' },
    main: {
      major: { version: majorVersion, game_pkgs: [], res_list_url: '' },
      patches: patches.map((p) => ({ version: p.version, game_pkgs: [], res_list_url: '' })),
      required_client_version: ''
    }
  }
}

describe('decideAction', () => {
  it('returns fresh_install when there is no existing state', () => {
    const action = decideAction(makeInfo('0.1.51'), null)
    expect(action).toEqual({ kind: 'fresh_install', target: { version: '0.1.51', game_pkgs: [], res_list_url: '' } })
  })

  it('returns up_to_date when the installed version matches main.major', () => {
    const state: InstallState = { version: '0.1.51', installDir: '/x', files: [] }
    const action = decideAction(makeInfo('0.1.51'), state)
    expect(action).toEqual({ kind: 'up_to_date' })
  })

  it('returns apply_patch when a patch matches the installed version', () => {
    const state: InstallState = { version: '0.0.51', installDir: '/x', files: [] }
    const action = decideAction(makeInfo('0.1.51', [{ version: '0.0.51' }]), state)
    expect(action.kind).toBe('apply_patch')
    if (action.kind === 'apply_patch') {
      expect(action.patch.version).toBe('0.0.51')
      expect(action.toVersion).toBe('0.1.51')
    }
  })

  it('falls back to fresh_install when no patch matches (gap too large)', () => {
    const state: InstallState = { version: '0.0.1', installDir: '/x', files: [] }
    const action = decideAction(makeInfo('0.1.51', [{ version: '0.0.51' }]), state)
    expect(action.kind).toBe('fresh_install')
  })

  it('throws when the backend publishes no major version at all', () => {
    const info = makeInfo('0.1.51')
    info.main.major = null
    expect(() => decideAction(info, null)).toThrow()
  })

  it('returns fresh_install (not a crash) when state exists but installDir/files are stale and version has no matching patch', () => {

    const state: InstallState = { version: '0.0.1', installDir: '/does/not/exist', files: [{ path: 'a', md5: 'x' }] }
    const action = decideAction(makeInfo('0.1.51', [{ version: '0.0.51' }]), state)
    expect(action.kind).toBe('fresh_install')
  })

  it('returns resume_audio_patch when a pending marker exists and InstallState already agrees with it', () => {
    const state: InstallState = { version: '1.1.0', installDir: '/x', files: [] }
    const pending = { toVersion: '1.1.0', audioPkgs: [] }
    const action = decideAction(makeInfo('1.1.0'), state, pending)
    expect(action).toEqual({ kind: 'resume_audio_patch', pending })
  })

  it('does NOT return resume_audio_patch when the marker exists but InstallState has not been bumped to it yet (crash-between-writes window)', () => {
    const state: InstallState = { version: '1.0.0', installDir: '/x', files: [] }
    const pending = { toVersion: '1.1.0', audioPkgs: [] }
    const action = decideAction(makeInfo('1.1.0', [{ version: '1.0.0' }]), state, pending)
    expect(action.kind).toBe('apply_patch')
  })

  it('does NOT return resume_audio_patch when there is no InstallState at all', () => {
    const pending = { toVersion: '1.1.0', audioPkgs: [] }
    const action = decideAction(makeInfo('1.1.0'), null, pending)
    expect(action.kind).toBe('fresh_install')
  })
})

describe('reassembleParts', () => {
  let server: Server
  let baseUrl: string
  let tempDirs: string[] = []

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'csore-reassemble-test-'))
    tempDirs.push(dir)
    mockUserDataDir.current = dir
    return dir
  }

  afterEach(async () => {
    server?.close()
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
    tempDirs = []
  })

  it('downloads every part and concatenates them in array order, not completion order', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    const chunkA = Buffer.from('AAAA')
    const chunkB = Buffer.from('BBBBBB')
    const byUrl: Record<string, Buffer> = { '/a': chunkA, '/b': chunkB }

    server = createServer((req, res) => {
      const body = byUrl[req.url ?? '']
      res.writeHead(200, { 'Content-Length': String(body.length) })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/a`, md5: createHash('md5').update(chunkA).digest('hex'), size: String(chunkA.length), decompressed_size: '0' },
      { url: `${baseUrl}/b`, md5: createHash('md5').update(chunkB).digest('hex'), size: String(chunkB.length), decompressed_size: '0' }
    ]

    await reassembleParts(parts, destZip, partsDir)

    const got = await readFile(destZip)
    expect(got.equals(Buffer.concat([chunkA, chunkB]))).toBe(true)
  })

  it('reports progress in bytes across all parts (total = sum of part sizes, monotonic, ends at total)', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    const chunkA = Buffer.alloc(3000, 'a')
    const chunkB = Buffer.alloc(5000, 'b')
    const byUrl: Record<string, Buffer> = { '/a': chunkA, '/b': chunkB }

    server = createServer((req, res) => {
      const body = byUrl[req.url ?? '']
      res.writeHead(200, { 'Content-Length': String(body.length) })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/a`, md5: createHash('md5').update(chunkA).digest('hex'), size: String(chunkA.length), decompressed_size: '0' },
      { url: `${baseUrl}/b`, md5: createHash('md5').update(chunkB).digest('hex'), size: String(chunkB.length), decompressed_size: '0' }
    ]

    const updates: Array<[number, number]> = []
    await reassembleParts(parts, destZip, partsDir, (processed, total) => updates.push([processed, total]))

    expect(updates.length).toBeGreaterThanOrEqual(3)
    expect(updates.every(([, total]) => total === 8000)).toBe(true)
    for (let i = 1; i < updates.length; i++) expect(updates[i][0]).toBeGreaterThanOrEqual(updates[i - 1][0])
    expect(updates.map(([p]) => p)).toContain(3000)
    expect(updates[updates.length - 1]).toEqual([8000, 8000])
  })

  it('downloads parts in array order even when later parts would resolve faster', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    const chunkA = Buffer.from('slow-part-A')
    const chunkB = Buffer.from('fast-part-B')
    const byUrl: Record<string, Buffer> = { '/slow': chunkA, '/fast': chunkB }

    server = createServer((req, res) => {
      const body = byUrl[req.url ?? '']
      const delay = req.url === '/slow' ? 30 : 0
      setTimeout(() => {
        res.writeHead(200, { 'Content-Length': String(body.length) })
        res.end(body)
      }, delay)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    // Array order is slow-part-A then fast-part-B.
    const parts: PkgEntry[] = [
      { url: `${baseUrl}/slow`, md5: createHash('md5').update(chunkA).digest('hex'), size: String(chunkA.length), decompressed_size: '0' },
      { url: `${baseUrl}/fast`, md5: createHash('md5').update(chunkB).digest('hex'), size: String(chunkB.length), decompressed_size: '0' }
    ]

    await reassembleParts(parts, destZip, partsDir)

    const got = await readFile(destZip)
    expect(got.equals(Buffer.concat([chunkA, chunkB]))).toBe(true)
  })

  const FAST_RETRY_OPTIONS = { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 50 }

  it('retries a part that fails transiently and succeeds once the server recovers', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    const chunk = Buffer.from('flaky-part-content')
    let requestCount = 0

    server = createServer((req, res) => {
      requestCount++
      if (requestCount <= 2) {

        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'Content-Length': String(chunk.length) })
      res.end(chunk)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/flaky`, md5: createHash('md5').update(chunk).digest('hex'), size: String(chunk.length), decompressed_size: '0' }
    ]

    await reassembleParts(parts, destZip, partsDir, undefined, undefined, undefined, FAST_RETRY_OPTIONS)

    expect(requestCount).toBe(3) // 2 failures + 1 success
    const got = await readFile(destZip)
    expect(got.equals(chunk)).toBe(true)
  })

  it('propagates the error once retries are exhausted, exactly as a non-retried failure would', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    let requestCount = 0
    server = createServer((_req, res) => {
      requestCount++
      res.writeHead(500)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/always-fails`, md5: createHash('md5').update(Buffer.from('x')).digest('hex'), size: '1', decompressed_size: '0' }
    ]

    await expect(
      reassembleParts(parts, destZip, partsDir, undefined, undefined, undefined, FAST_RETRY_OPTIONS)
    ).rejects.toThrow(/download failed/)

    // maxAttempts: 4 -- the initial attempt plus exactly 3 retries, never
    // more (retries are bounded, not unbounded).
    expect(requestCount).toBe(4)
  })

  it('never retries DownloadPausedError and propagates it with no backoff delay', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    let requestCount = 0
    server = createServer((_req, res) => {
      requestCount++

      res.writeHead(200, { 'Content-Length': '1' })
      res.end('x')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/paused`, md5: createHash('md5').update(Buffer.from('x')).digest('hex'), size: '1', decompressed_size: '0' }
    ]

    const controller = new AbortController()
    controller.abort()

    // A retry would exceed the 50 ms backoff budget.
    const start = Date.now()
    await expect(
      reassembleParts(parts, destZip, partsDir, undefined, undefined, controller.signal, FAST_RETRY_OPTIONS)
    ).rejects.toBeInstanceOf(DownloadPausedError)
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeLessThan(50)
    expect(requestCount).toBe(0)
  })

  it('stops promptly when the external signal fires DURING a retry backoff sleep, instead of waiting out the full delay', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    let requestCount = 0
    server = createServer((req, _res) => {
      requestCount++

      req.socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/fails-then-paused`, md5: createHash('md5').update(Buffer.from('x')).digest('hex'), size: '1', decompressed_size: '0' }
    ]

    const controller = new AbortController()

    const SLOW_BACKOFF = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 2000 }

    // Fire the abort shortly after the first attempt is expected to have
    // failed and entered its backoff sleep.
    setTimeout(() => controller.abort(), 50)

    const start = Date.now()
    await expect(
      reassembleParts(parts, destZip, partsDir, undefined, undefined, controller.signal, SLOW_BACKOFF)
    ).rejects.toBeInstanceOf(DownloadPausedError)
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeLessThan(500)
    expect(requestCount).toBe(1) // only the initial attempt, no retry fired
  })

  it('has no retry overhead on a normal, successful first attempt', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    const chunk = Buffer.from('clean-first-try')
    let requestCount = 0
    server = createServer((_req, res) => {
      requestCount++
      res.writeHead(200, { 'Content-Length': String(chunk.length) })
      res.end(chunk)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/clean`, md5: createHash('md5').update(chunk).digest('hex'), size: String(chunk.length), decompressed_size: '0' }
    ]

    const start = Date.now()
    await reassembleParts(parts, destZip, partsDir, undefined, undefined, undefined, FAST_RETRY_OPTIONS)
    const elapsedMs = Date.now() - start

    expect(requestCount).toBe(1)
    expect(elapsedMs).toBeLessThan(50)
    const got = await readFile(destZip)
    expect(got.equals(chunk)).toBe(true)
  })
})
