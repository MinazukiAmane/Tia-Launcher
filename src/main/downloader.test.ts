
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { mkdtemp, rm, writeFile, readFile, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { downloadPart, DownloadVerificationError, type DownloadPart } from './downloader'

const CONTENT = Buffer.from('x'.repeat(5000), 'utf-8')
const CONTENT_MD5 = createHash('md5').update(CONTENT).digest('hex')

let server: Server
let baseUrl: string

const CHUNK = Buffer.from('y'.repeat(1000), 'utf-8')
const CHUNK_DELAY_MS = 50
const SLOW_CHUNK_COUNT = 10 // 10 * 1000 bytes = 10000 bytes total if never aborted

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/always-200') {

      res.writeHead(200, { 'Content-Length': String(CONTENT.length) })
      res.end(CONTENT)
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
})
