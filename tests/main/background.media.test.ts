import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { importBackground, readBackgroundSources, readBackgroundDataUrl, clearBackgrounds, isValidBackgroundName } from '../../src/main/background'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('accepts GIF while ignoring legacy custom videos and removes them on reset', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'tia-bg-media-')); dirs.push(dir)
 const image = join(dir, 'image.gif')
 await writeFile(image, 'GIF89a')
 await importBackground(dir, image)
 await writeFile(join(dir, 'backgrounds', 'custom-999.webm'), 'legacy video')
 expect(await readBackgroundSources(dir)).toEqual({ image: 'data:image/gif;base64,R0lGODlh', video: null })
 expect(await readBackgroundDataUrl(dir, 'custom-999.webm')).toBeNull()
 await clearBackgrounds(dir)
 expect(await readdir(join(dir, 'backgrounds'))).toEqual([])
})
it('rejects video uploads in the main process even when the native picker is bypassed', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'tia-bg-reject-')); dirs.push(dir)
 for (const extension of ['mp4', 'webm', 'MP4']) {
  const file = join(dir, `clip.${extension}`)
  await writeFile(file, 'video')
  await expect(importBackground(dir, file)).rejects.toThrow('Unsupported image type')
 }
 expect(await readBackgroundSources(dir)).toEqual({ image: null, video: null })
})
it('rejects custom video names and path traversal', () => {
 for (const name of ['custom-123.mp4', 'custom-123.webm', '../movie.mp4', 'custom-1.mp4/../../secret', 'custom-1.exe']) expect(isValidBackgroundName(name)).toBe(false)
 expect(isValidBackgroundName('custom-123.gif')).toBe(true)
})
