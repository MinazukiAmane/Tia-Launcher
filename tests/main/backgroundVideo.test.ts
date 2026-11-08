import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, truncate } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { importBackground, clearBackgrounds, readBackgroundSources } from '../../src/main/background'
import { importBackgroundVideo, clearBackgroundVideos } from '../../src/main/backgroundVideo'
import { serveBackgroundVideo, VIDEO_EXTENSIONS, VIDEO_NAME, MAX_VIDEO_BYTES } from '../../src/main/backgroundMedia'
import { canPlayBackgroundVideo } from '../../src/main/videoPlayback'
import { convertBackgroundVideo, mediaConverter } from '../../src/main/mediaConverter'
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../../src/main/settings'

vi.mock('../../src/main/videoPlayback', () => ({ canPlayBackgroundVideo: vi.fn() }))
vi.mock('../../src/main/mediaConverter', () => ({ mediaConverter: vi.fn(), convertBackgroundVideo: vi.fn() }))
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tia-media-')); vi.mocked(canPlayBackgroundVideo).mockReset().mockResolvedValue(true); vi.mocked(mediaConverter).mockReset().mockResolvedValue('converter'); vi.mocked(convertBackgroundVideo).mockReset() })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function source(extension: string): Promise<string> {
  const file = join(root, 'source.' + extension)
  await writeFile(file, 'test video bytes')
  return file
}

describe('separate custom images and videos', () => {
  it('retains both media selections across SQLite reloads and resets only the requested kind', async () => {
    const video = await importBackgroundVideo(root, await source('mp4'), async () => true)
    const image = await importBackground(root, await source('avif'))
    await writeSettings(root, { ...DEFAULT_SETTINGS, customBackground: image, customVideo: video })
    const restored = await readSettings(root)
    const sources = await readBackgroundSources(root, restored.customVideo)
    expect(sources.image).toMatch(/^data:image\/avif;/)
    expect(sources.video).toBe('tia-background://video/' + video)
    await clearBackgrounds(root)
    expect(await readdir(join(root, 'backgrounds'))).toEqual([video])
    const secondImage = await importBackground(root, await source('bmp'))
    await clearBackgroundVideos(root)
    expect(await readdir(join(root, 'backgrounds'))).toEqual([secondImage])
  })

  it.each(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'avif', 'apng', 'bmp', 'ico', 'svg'])('imports image format %s', async extension => {
    expect(await importBackground(root, await source(extension))).toMatch(new RegExp('\\.' + extension + '$'))
  })

  it.each(VIDEO_EXTENSIONS)('keeps a playable %s video unchanged without converting', async extension => {
    const confirm = vi.fn()
    const original = await source(extension)
    const name = await importBackgroundVideo(root, original, confirm)
    expect(name && VIDEO_NAME.test(name)).toBe(true)
    expect(await readFile(join(root, 'backgrounds', name!))).toEqual(await readFile(original))
    expect(confirm).not.toHaveBeenCalled()
    expect(mediaConverter).not.toHaveBeenCalled()
  })

  it('keeps the old background when conversion is declined or fails and removes temporary files', async () => {
    const old = await importBackgroundVideo(root, await source('mp4'), async () => true)
    vi.mocked(canPlayBackgroundVideo).mockResolvedValue(false)
    expect(await importBackgroundVideo(root, await source('avi'), async () => false)).toBeNull()
    expect(await readdir(join(root, 'backgrounds'))).toEqual([old])
    vi.mocked(convertBackgroundVideo).mockRejectedValueOnce(new Error('conversion failed'))
    await expect(importBackgroundVideo(root, await source('wmv'), async () => true)).rejects.toThrow('conversion failed')
    expect(await readdir(join(root, 'backgrounds'))).toEqual([old])
  })

  it('converts only after consent and validates the resulting video before accepting it', async () => {
    vi.mocked(canPlayBackgroundVideo).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    vi.mocked(convertBackgroundVideo).mockImplementationOnce(async (_tool, _input, output) => { await writeFile(output, 'converted mp4') })
    const confirm = vi.fn().mockResolvedValue(true)
    const name = await importBackgroundVideo(root, await source('flv'), confirm)
    expect(confirm).toHaveBeenCalledOnce()
    expect(await readFile(join(root, 'backgrounds', name!), 'utf8')).toBe('converted mp4')
    expect(await readdir(join(root, 'backgrounds'))).toEqual([name])
  })

  it('rejects oversized inputs and unsafe saved video names', async () => {
    const file = await source('mp4')
    await truncate(file, MAX_VIDEO_BYTES + 1)
    await expect(importBackgroundVideo(root, file, async () => true)).rejects.toThrow('too large')
    await writeSettings(root, { ...DEFAULT_SETTINGS, customVideo: '../private.mp4' })
    expect((await readSettings(root)).customVideo).toBeNull()
  })
})

describe('local video streaming', () => {
  it('streams full content, byte ranges, suffixes, and HEAD without loading the entire video', async () => {
    const name = 'custom-video-abcdef.mp4'
    await mkdir(join(root, 'backgrounds'))
    await writeFile(join(root, 'backgrounds', name), '0123456789')
    const url = 'tia-background://video/' + name
    expect(await (await serveBackgroundVideo(root, new Request(url))).text()).toBe('0123456789')
    const partial = await serveBackgroundVideo(root, new Request(url, { headers: { Range: 'bytes=2-4' } }))
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await partial.text()).toBe('234')
    expect(await (await serveBackgroundVideo(root, new Request(url, { headers: { Range: 'bytes=-3' } }))).text()).toBe('789')
    const head = await serveBackgroundVideo(root, new Request(url, { method: 'HEAD' }))
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    expect((await serveBackgroundVideo(root, new Request(url, { headers: { Range: 'bytes=12-' } }))).status).toBe(416)
    expect((await serveBackgroundVideo(root, new Request('tia-background://video/..%2fprivate.mp4'))).status).toBe(404)
  })
})
