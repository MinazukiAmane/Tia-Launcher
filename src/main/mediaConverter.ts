import { promises as fs, createWriteStream, createReadStream } from 'fs'
import { join, delimiter } from 'path'
import { createHash, randomUUID } from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { spawn } from 'child_process'
import assets from './mediaConverterAssets.json'

const base = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/'
const children = new Set<ReturnType<typeof spawn>>()
export function stopMediaConversion(): void { children.forEach(child => child.kill('SIGKILL')) }

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(asset: { name: string; size: number; sha256: string }, file: string): Promise<void> {
  const res = await fetch(base + asset.name, { signal: AbortSignal.timeout(600000) })
  if (!res.ok || !res.body) throw new Error(`Video component download failed: HTTP ${res.status}`)
  let size = 0
  const hash = createHash('sha256')
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length
    if (size > asset.size) return callback(new Error('Video component download exceeded declared size'))
    hash.update(chunk); callback(null, chunk)
  } })
  try {
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), limit, createWriteStream(file, { flags: 'wx', mode: 0o700 }))
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('Video component checksum mismatch')
  } catch (error) { await fs.rm(file, { force: true }); throw error }
}

export async function mediaConverter(userData: string): Promise<string> {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const file = join(folder, executable)
    try { if ((await fs.stat(file)).isFile()) { await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return file } } catch { /* Try the managed runtime next. */ }
  }
  const key = `${process.platform}-${process.arch}` as keyof typeof assets
  const entry = assets[key]
  if (!entry) throw new Error('Video conversion is not supported on this platform')
  const directory = join(userData, 'runtimes', 'media-b6.1.1')
  const file = join(directory, executable)
  try { if (await digest(file) === entry.binary.sha256) return file } catch { /* Download a verified copy. */ }
  await fs.mkdir(directory, { recursive: true })
  const temporary = join(directory, `download-${randomUUID()}`)
  try {
    // Keep the upstream license and source/build information alongside the tool.
    for (const asset of entry.notices) {
      const target = join(directory, asset.name)
      try { if (await digest(target) === asset.sha256) continue } catch { /* Missing notice. */ }
      await download(asset, temporary)
      await fs.rename(temporary, target)
    }
    await download(entry.binary, temporary)
    await fs.rm(file, { force: true })
    await fs.rename(temporary, file)
    return file
  } finally { await fs.rm(temporary, { force: true }) }
}

export async function convertBackgroundVideo(executable: string, source: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-fs', String(200 * 1024 * 1024 + 1), '-n', destination], { windowsHide: true, timeout: 1200000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    let detail = ''
    child.stderr?.on('data', chunk => { detail = (detail + String(chunk)).slice(-4000) })
    child.once('error', error => { children.delete(child); reject(error) })
    child.once('close', code => { children.delete(child); code === 0 ? resolve() : reject(new Error(`Video conversion failed: ${detail}`)) })
  })
}
