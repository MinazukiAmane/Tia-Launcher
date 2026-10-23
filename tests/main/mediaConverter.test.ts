import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../src/main/mediaConverterAssets.json', () => {
  const asset = (name: string) => ({ name, size: Buffer.byteLength(name), sha256: createHash('sha256').update(name).digest('hex') })
  return { default: { [`${process.platform}-${process.arch}`]: { binary: asset('test-ffmpeg'), notices: [asset('LICENSE'), asset('README')] } } }
})
import { mediaConverter } from '../../src/main/mediaConverter'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tia-converter-')); vi.stubEnv('PATH', '') })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it('downloads a verified component and its notices once, then reuses the cached binary', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(String(input).split('/').pop()!))
  const file = await mediaConverter(root)
  expect(await readFile(file, 'utf8')).toBe('test-ffmpeg')
  expect(await readFile(join(root, 'runtimes', 'media-b6.1.1', 'LICENSE'), 'utf8')).toBe('LICENSE')
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(await mediaConverter(root)).toBe(file)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('rejects a corrupt component and removes its partial download before it can execute', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const name = String(input).split('/').pop()!
    return new Response(name === 'test-ffmpeg' ? 'bad-ffmpeg!' : name)
  })
  await expect(mediaConverter(root)).rejects.toThrow(/checksum|declared size/)
  const files = await readdir(join(root, 'runtimes', 'media-b6.1.1'))
  expect(files.some(name => name.startsWith('download-') || name === 'ffmpeg' || name === 'ffmpeg.exe')).toBe(false)
})
