
import { promises as fs } from 'fs'
import { join, extname } from 'path'

export const MAX_BACKGROUND_BYTES = 25 * 1024 * 1024
const NAME_PATTERN = /^custom-\d+\.(png|jpe?g|webp|gif)$/
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

// Copies `sourcePath` in, removes any previous custom backgrounds, and returns the stored file name.
export async function importBackground(userDataDir: string, sourcePath: string): Promise<string> {
  const ext = extname(sourcePath).slice(1).toLowerCase()
  if (!MIME[ext]) throw new Error('Unsupported image type. Use PNG, JPG, WEBP or GIF.')
  const stat = await fs.stat(sourcePath)
  if (stat.size > MAX_BACKGROUND_BYTES) {
    throw new Error(`Image is too large (max ${MAX_BACKGROUND_BYTES / 1024 / 1024} MB).`)
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
    names.filter((n) => n !== keep && NAME_PATTERN.test(n)).map((n) => fs.rm(join(dir, n), { force: true }))
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
