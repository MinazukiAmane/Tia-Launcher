
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, rm, writeFile, readFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { downloadPart, DownloadVerificationError, DownloadPausedError, type DownloadPart } from './downloader'

const CONTENT = Buffer.from('x'.repeat(5000), 'utf-8')
const CONTENT_MD5 = createHash('md5').update(CONTENT).digest('hex')

const THROTTLE_CONTENT = Buffer.from('z'.repeat(40_000), 'utf-8')
const THROTTLE_CONTENT_MD5 = createHash('md5').update(THROTTLE_CONTENT).digest('hex')

let server: Server
let baseUrl: string

const CHUNK = Buffer.from('y'.repeat(1000), 'utf-8')
const CHUNK_DELAY_MS = 50
const SLOW_CHUNK_COUNT = 10 // 10 * 1000 bytes = 10000 bytes total if never aborted
const STEADY_CHUNK_DELAY_MS = 30

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/throttle-target') {
      res.writeHead(200, { 'Content-Length': String(THROTTLE_CONTENT.length) })
      const stepSize = 4000
      let offset = 0
      const sendNext = (): void => {
        if (offset >= THROTTLE_CONTENT.length) {
          res.end()
          return
        }
        const slice = THROTTLE_CONTENT.subarray(offset, offset + stepSize)
        offset += stepSize
        res.write(slice, () => setImmediate(sendNext))
      }
      sendNext()
      return
    }

    if (req.url === '/always-200') {

      res.writeHead(200, { 'Content-Length': String(CONTENT.length) })
      res.end(CONTENT)
      return
    }

    if (req.url === '/slow-but-steady') {
      // Abort only when data stops arriving; slow downloads remain valid.
      res.writeHead(200, { 'Content-Length': String(CONTENT.length) })
      const stepSize = 500
      let offset = 0
      const sendNext = (): void => {
        if (offset >= CONTENT.length) {
          res.end()
          return
        }
        const slice = CONTENT.subarray(offset, offset + stepSize)
        offset += stepSize
        res.write(slice, () => setTimeout(sendNext, STEADY_CHUNK_DELAY_MS))
      }
      sendNext()
      return
    }

    if (req.url === '/slow-oversized') {
      res.writeHead(200)
      let sent = 0
      const sendNext = (): void => {
        if (sent >= SLOW_CHUNK_COUNT || res.writableEnded) {
          res.end()
          return
        }
        sent += 1
        res.write(CHUNK, () => setTimeout(sendNext, CHUNK_DELAY_MS))
      }
      sendNext()
      return
    }

    const range = req.headers.range
    if (range) {
      const match = /^bytes=(\d+)-$/.exec(range)
      const start = match ? parseInt(match[1], 10) : 0
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}`,
        'Content-Length': String(CONTENT.length - start)
      })
      res.end(CONTENT.subarray(start))
    } else {
      res.writeHead(200, { 'Content-Length': String(CONTENT.length) })
      res.end(CONTENT)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind to a port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
  server.close()
})

let tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-downloader-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('downloadPart', () => {
  it('downloads a fresh file and verifies its MD5', async () => {
    const dir = await makeTempDir()
    const dest = join(dir, 'part1')
    const part: DownloadPart = { url: baseUrl, md5: CONTENT_MD5, size: CONTENT.length }

    await downloadPart(part, dest)

    const got = await readFile(dest)
    expect(got.equals(CONTENT)).toBe(true)
  })

  it('resumes from an existing partial file instead of restarting', async () => {
    const dir = await makeTempDir()
    const dest = join(dir, 'part1')
    const firstHalf = CONTENT.subarray(0, 2000)
    await writeFile(dest, firstHalf)

    const part: DownloadPart = { url: baseUrl, md5: CONTENT_MD5, size: CONTENT.length }
    let maxProgress = 0
    await downloadPart(part, dest, (written) => {
      maxProgress = Math.max(maxProgress, written)
    })

    const got = await readFile(dest)
    expect(got.equals(CONTENT)).toBe(true)
    expect(maxProgress).toBeLessThanOrEqual(CONTENT.length)
  })

  it('throws DownloadVerificationError and removes the file on MD5 mismatch', async () => {
    const dir = await makeTempDir()
    const dest = join(dir, 'part1')
    const part: DownloadPart = { url: baseUrl, md5: 'deadbeefdeadbeefdeadbeefdeadbeef', size: CONTENT.length }

    await expect(downloadPart(part, dest)).rejects.toBeInstanceOf(DownloadVerificationError)
    await expect(access(dest)).rejects.toThrow()
  })

  it('aborts and deletes the file instead of writing past the declared size', async () => {
    const dir = await makeTempDir()
    const dest = join(dir, 'part1')

    const declaredSize = CHUNK.length * 2
    const part: DownloadPart = {
      url: `${baseUrl}/slow-oversized`,
      md5: 'deadbeefdeadbeefdeadbeefdeadbeef',
      size: declaredSize
    }

    const start = Date.now()
    await expect(downloadPart(part, dest)).rejects.toThrow()
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeLessThan(SLOW_CHUNK_COUNT * CHUNK_DELAY_MS)
    await expect(access(dest)).rejects.toThrow()
  })

  it('does not abort a slow-but-steady download whose total time exceeds the idle timeout', async () => {
    const dir = await makeTempDir()
    const dest = join(dir, 'part1')
    const part: DownloadPart = { url: `${baseUrl}/slow-but-steady`, md5: CONTENT_MD5, size: CONTENT.length }

    // Abort only when data stops arriving; slow downloads remain valid.
    const idleTimeoutMs = 100
    const start = Date.now()
    await downloadPart(part, dest, undefined, idleTimeoutMs)
    const elapsedMs = Date.now() - start

    expect(elapsedMs).toBeGreaterThan(idleTimeoutMs)
    const got = await readFile(dest)
    expect(got.equals(CONTENT)).toBe(true)
  })

  it('restarts cleanly over an existing partial when the server ignores Range and returns 200', async () => {
    const dir = await makeTempDir()
    const dest = join(dir, 'part1')
    const firstHalf = CONTENT.subarray(0, 2000)
    await writeFile(dest, firstHalf)

    const part: DownloadPart = { url: `${baseUrl}/always-200`, md5: CONTENT_MD5, size: CONTENT.length }
    await downloadPart(part, dest)

    const got = await readFile(dest)

    expect(got.length).toBe(CONTENT.length)
    expect(got.equals(CONTENT)).toBe(true)
  })

  describe('externalSignal pause/resume', () => {
    it('stops cleanly mid-transfer, leaves the partial file intact, and rejects with DownloadPausedError (not DownloadVerificationError)', async () => {
      const dir = await makeTempDir()
      const dest = join(dir, 'part1')

      const part: DownloadPart = { url: `${baseUrl}/slow-but-steady`, md5: CONTENT_MD5, size: CONTENT.length }

      const controller = new AbortController()
      setTimeout(() => controller.abort(), 65) // after roughly 2 chunks

      await expect(downloadPart(part, dest, undefined, undefined, undefined, controller.signal)).rejects.toBeInstanceOf(
        DownloadPausedError
      )

      const partial = await readFile(dest)
      expect(partial.length).toBeGreaterThan(0)
      expect(partial.length).toBeLessThan(CONTENT.length)
      expect(CONTENT.subarray(0, partial.length).equals(partial)).toBe(true)
    })

    it('genuinely resumes and completes after a pause, passing MD5 verification', async () => {
      const dir = await makeTempDir()
      const dest = join(dir, 'part1')
      const part: DownloadPart = { url: `${baseUrl}/slow-but-steady`, md5: CONTENT_MD5, size: CONTENT.length }

      const controller = new AbortController()
      setTimeout(() => controller.abort(), 65)
      await expect(downloadPart(part, dest, undefined, undefined, undefined, controller.signal)).rejects.toBeInstanceOf(
        DownloadPausedError
      )
      const partialSize = (await readFile(dest)).length
      expect(partialSize).toBeGreaterThan(0)
      expect(partialSize).toBeLessThan(CONTENT.length)

      await downloadPart(part, dest)

      const got = await readFile(dest)
      expect(got.length).toBe(CONTENT.length)
      expect(got.equals(CONTENT)).toBe(true)
    })

    it('throws DownloadPausedError immediately if the signal is already aborted before starting', async () => {
      const dir = await makeTempDir()
      const dest = join(dir, 'part1')
      const part: DownloadPart = { url: baseUrl, md5: CONTENT_MD5, size: CONTENT.length }

      const controller = new AbortController()
      controller.abort()

      await expect(downloadPart(part, dest, undefined, undefined, undefined, controller.signal)).rejects.toBeInstanceOf(
        DownloadPausedError
      )
      await expect(access(dest)).rejects.toThrow() // never started, nothing written
    })
  })

  describe('maxBytesPerSecond throttling', () => {
    it('measurably slows a download while still completing and passing MD5 verification', async () => {
      const dir = await makeTempDir()
      const dest = join(dir, 'part1')
      const part: DownloadPart = {
        url: `${baseUrl}/throttle-target`,
        md5: THROTTLE_CONTENT_MD5,
        size: THROTTLE_CONTENT.length
      }

      // 10,000 bytes/sec against a 40,000 byte body should take at least
      // ~4 seconds if the cap is genuinely enforced.
      const maxBytesPerSecond = 10_000
      const start = Date.now()
      await downloadPart(part, dest, undefined, undefined, maxBytesPerSecond)
      const elapsedMs = Date.now() - start

      const got = await readFile(dest)
      expect(got.equals(THROTTLE_CONTENT)).toBe(true)

      const expectedMinMs = (THROTTLE_CONTENT.length / maxBytesPerSecond) * 1000

      expect(elapsedMs).toBeGreaterThan(expectedMinMs * 0.8)
    }, 15_000)

    it('does not slow down the default (no limit) path at all', async () => {
      const dir = await makeTempDir()
      const dest = join(dir, 'part1')
      const part: DownloadPart = {
        url: `${baseUrl}/throttle-target`,
        md5: THROTTLE_CONTENT_MD5,
        size: THROTTLE_CONTENT.length
      }

      const start = Date.now()
      // No maxBytesPerSecond argument at all -- the untouched default path.
      await downloadPart(part, dest)
      const elapsedMs = Date.now() - start

      const got = await readFile(dest)
      expect(got.equals(THROTTLE_CONTENT)).toBe(true)

      expect(elapsedMs).toBeLessThan(1000)
    })

    it('treats maxBytesPerSecond: 0 as unlimited (same as undefined)', async () => {
      const dir = await makeTempDir()
      const dest = join(dir, 'part1')
      const part: DownloadPart = {
        url: `${baseUrl}/throttle-target`,
        md5: THROTTLE_CONTENT_MD5,
        size: THROTTLE_CONTENT.length
      }

      const start = Date.now()
      await downloadPart(part, dest, undefined, undefined, 0)
      const elapsedMs = Date.now() - start

      const got = await readFile(dest)
      expect(got.equals(THROTTLE_CONTENT)).toBe(true)
      expect(elapsedMs).toBeLessThan(1000)
    })

    it('still only aborts the idle timer on genuine silence, not on its own throttle pacing', async () => {
      const dir = await makeTempDir()
      const dest = join(dir, 'part1')
      const part: DownloadPart = {
        url: `${baseUrl}/throttle-target`,
        md5: THROTTLE_CONTENT_MD5,
        size: THROTTLE_CONTENT.length
      }

      // Abort only when data stops arriving; slow downloads remain valid.
      const idleTimeoutMs = 200
      const maxBytesPerSecond = 5_000 // ~8s to fully deliver 40,000 bytes
      await downloadPart(part, dest, undefined, idleTimeoutMs, maxBytesPerSecond)

      const got = await readFile(dest)
      expect(got.equals(THROTTLE_CONTENT)).toBe(true)
    }, 15_000)
  })
})
