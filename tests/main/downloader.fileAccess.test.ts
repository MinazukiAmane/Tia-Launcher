import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { Readable } from 'stream'

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})
import { open } from 'fs/promises'
import { createReadStream } from 'fs'
import { downloadPart } from '../../src/main/downloader'

let folder: string
const bytes = Buffer.from('verified client bytes')
const part = { url: 'https://example.test/client', size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') }
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'csore-download-access-'))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await rm(folder, { recursive: true, force: true })
})
it('retries a temporarily locked output before streaming and verifies the result', async () => {
  vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }))
  const target = join(folder, 'client')
  await downloadPart(part, target)
  expect(open).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await readFile(target)).toEqual(bytes)
})
it('retries verification of an already complete file without redownloading it', async () => {
  const target = join(folder, 'client')
  await writeFile(target, bytes)
  const failed = new Readable({ read() { this.destroy(Object.assign(new Error('scanner lock'), { code: 'EBUSY' })) } })
  vi.mocked(createReadStream).mockReturnValueOnce(failed as ReturnType<typeof createReadStream>)
  await downloadPart(part, target)
  expect(createReadStream).toHaveBeenCalledTimes(2)
  expect(fetch).not.toHaveBeenCalled()
  expect(await readFile(target)).toEqual(bytes)
})
it('reports the local path and error code for a persistent disk failure', async () => {
  vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }))
  const target = join(folder, 'client')
  await expect(downloadPart(part, target)).rejects.toMatchObject({ code: 'EIO', path: target, message: expect.stringContaining('Cannot access download file') })
  expect(open).toHaveBeenCalledTimes(1)
})

it('refuses a hard-linked download cache without overwriting its target', async () => {
  const fs = await import('fs/promises')
  const outside = join(folder, 'save'), target = join(folder, 'download')
  await writeFile(outside, 'keep')
  await fs.link(outside, target)
  await expect(downloadPart(part, target)).rejects.toThrow(/unlinked/)
  expect(await readFile(outside, 'utf8')).toBe('keep')
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects an incorrect partial response before appending bytes to a resume file', async () => {
  const target = join(folder, 'download')
  await writeFile(target, bytes.subarray(0, 4))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } })))
  await expect(downloadPart(part, target)).rejects.toThrow(/byte range/)
  expect(await readFile(target)).toEqual(bytes.subarray(0, 4))
})

it('rejects mismatched declared sizes even if the checksum matches the response', async () => {
  const target = join(folder, 'download')
  await expect(downloadPart({ ...part, size: part.size + 10 }, target)).rejects.toThrow(/MD5 verification/)
})
