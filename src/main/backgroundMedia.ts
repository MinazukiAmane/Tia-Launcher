import { promises as fs, createReadStream } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'

export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mpe', 'm2v', 'ts', 'mts', 'm2ts', '3gp', '3g2', 'vob', 'ogv', 'ogg', 'mxf', 'f4v']
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024
export const VIDEO_NAME = /^custom-video-[a-f0-9-]+\.(mp4|webm|mov|m4v|mkv|avi|wmv|flv|mpg|mpeg|mpe|m2v|ts|mts|m2ts|3gp|3g2|vob|ogv|ogg|mxf|f4v)$/

export function backgroundVideoUrl(name: string): string {
  return `tia-background://video/${name}`
}

// Serve only managed media, with byte ranges for seeking and metadata probes.
export async function serveBackgroundVideo(userData: string, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const name = url.pathname.slice(1)
  if (url.hostname !== 'video' || !VIDEO_NAME.test(name) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })
  const file = join(userData, 'backgrounds', name)
  let size: number
  try {
    const info = await fs.lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) return new Response(null, { status: 404 })
    size = info.size
  } catch { return new Response(null, { status: 404 }) }
  let start = 0, end = size - 1
  const range = request.headers.get('range')
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const headers: Record<string, string> = {
    'Content-Type': name.endsWith('.webm') ? 'video/webm' : 'video/mp4',
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status: range ? 206 : 200, headers })
  const stream = createReadStream(file, { start, end })
  const abort = (): void => { stream.destroy() }
  request.signal.addEventListener('abort', abort, { once: true })
  stream.once('close', () => request.signal.removeEventListener('abort', abort))
  if (request.signal.aborted) abort()
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers })
}
