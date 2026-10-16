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
import { downloadPart } from './downloader'

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
