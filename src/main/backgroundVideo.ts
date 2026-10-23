import { promises as fs } from 'fs'
import { join, extname } from 'path'
import { randomUUID } from 'crypto'
import { VIDEO_EXTENSIONS, MAX_VIDEO_BYTES, VIDEO_NAME, backgroundVideoUrl } from './backgroundMedia'
import { canPlayBackgroundVideo } from './videoPlayback'
import { convertBackgroundVideo, mediaConverter } from './mediaConverter'

export async function clearBackgroundVideos(userData: string, keep?: string): Promise<void> {
  const directory = join(userData, 'backgrounds')
  let names: string[]
  try { names = await fs.readdir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  await Promise.all(names.filter(name => name !== keep && /^custom-video-[a-f0-9-]+\.[a-z0-9]+$/.test(name)).map(name => fs.rm(join(directory, name), { force: true })))
}

export async function importBackgroundVideo(userData: string, source: string, confirmConversion: () => Promise<boolean>): Promise<string | null> {
  const extension = extname(source).slice(1).toLowerCase()
  const info = await fs.stat(source)
  if (!VIDEO_EXTENSIONS.includes(extension) || !info.isFile() || info.size === 0) throw new Error('Unsupported background video')
  if (info.size > MAX_VIDEO_BYTES) throw new Error('Background video is too large (max 200 MB)')
  const directory = join(userData, 'backgrounds')
  await fs.mkdir(directory, { recursive: true })
  const id = randomUUID()
  const candidate = `custom-video-${id}.${extension}`
  const file = join(directory, candidate)
  const output = `custom-video-${randomUUID()}.mp4`
  let saved: string | null = null
  try {
    await fs.copyFile(source, file)
    if (await canPlayBackgroundVideo(backgroundVideoUrl(candidate))) { saved = candidate; return saved }
    if (!(await confirmConversion())) return null
    await convertBackgroundVideo(await mediaConverter(userData), file, join(directory, output))
    const converted = await fs.stat(join(directory, output))
    if (converted.size >= MAX_VIDEO_BYTES || !(await canPlayBackgroundVideo(backgroundVideoUrl(output)))) throw new Error('Background video conversion failed')
    saved = output
    return saved
  } finally {
    if (saved !== candidate) await fs.rm(file, { force: true })
    if (saved !== output) await fs.rm(join(directory, output), { force: true })
  }
}

export async function readBackgroundVideoUrl(userData: string, name: unknown): Promise<string | null> {
  if (typeof name !== 'string' || !VIDEO_NAME.test(name)) return null
  try { const info = await fs.lstat(join(userData, 'backgrounds', name)); return info.isFile() && !info.isSymbolicLink() ? backgroundVideoUrl(name) : null } catch { return null }
}
