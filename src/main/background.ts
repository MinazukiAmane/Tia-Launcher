
import { promises as fs } from 'fs'
import { join, extname } from 'path'

export const MAX_BACKGROUND_BYTES = 25 * 1024 * 1024
const NAME_PATTERN = /^custom-\d+\.(png|jpe?g|webp|gif)$/
const CLEANUP_PATTERN = /^custom-\d+\.(png|jpe?g|webp|gif|mp4|webm)$/
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

export function isValidBackgroundName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name)
}

function backgroundsDir(userDataDir: string): string {
  return join(userDataDir, 'backgrounds')
}

// Replace the previous custom image.
export async function importBackground(userDataDir: string, sourcePath: string): Promise<string> {
  const ext = extname(sourcePath).slice(1).toLowerCase()
  if (!MIME[ext]) throw new Error('Unsupported image type. Use PNG, JPG, WEBP or GIF.')
  const stat = await fs.stat(sourcePath)
  const limit = MAX_BACKGROUND_BYTES
  if (!stat.isFile()) throw new Error('Choose a background file.')
  if (stat.size > limit) {
    throw new Error(`Background is too large (max ${limit / 1024 / 1024} MB).`)
  }
  const dir = backgroundsDir(userDataDir)
  await fs.mkdir(dir, { recursive: true })
  const name = `custom-${Date.now()}.${ext}`
  await fs.copyFile(sourcePath, join(dir, name))
  await removeOtherBackgrounds(userDataDir, name)
  return name
}

async function removeOtherBackgrounds(userDataDir: string, keep: string | null): Promise<void> {
  const dir = backgroundsDir(userDataDir)
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    names.filter((n) => n !== keep && CLEANUP_PATTERN.test(n)).map((n) => fs.rm(join(dir, n), { force: true }))
  )
}

export async function clearBackgrounds(userDataDir: string): Promise<void> {
  await removeOtherBackgrounds(userDataDir, null)
}

export async function readBackgroundDataUrl(userDataDir: string, name: string | null): Promise<string | null> {
  if (!isValidBackgroundName(name)) return null
  try {
    const buf = await fs.readFile(join(backgroundsDir(userDataDir), name))
    const ext = extname(name).slice(1).toLowerCase()
    return `data:${MIME[ext]};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

export async function readBackgroundSources(userDataDir: string): Promise<{ image: string | null; video: string | null }> {
 let names: string[] = []
 try { names = (await fs.readdir(backgroundsDir(userDataDir))).filter(isValidBackgroundName).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })) }
 catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
 const image = names[0] ?? null
 return { image: await readBackgroundDataUrl(userDataDir, image), video: null }
}
