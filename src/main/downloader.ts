
import { createWriteStream, createReadStream } from 'fs'
import { stat, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export interface DownloadPart {
  url: string
  md5: string
  size: number
}

export class DownloadVerificationError extends Error {
  constructor(public readonly part: DownloadPart) {
    super(`downloaded file failed MD5 verification: ${part.url}`)
    this.name = 'DownloadVerificationError'
  }
}

async function existingSize(destPath: string): Promise<number> {
  try {
    return (await stat(destPath)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}

async function md5OfFile(path: string): Promise<string> {
  const hash = createHash('md5')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export async function downloadPart(
  part: DownloadPart,
  destPath: string,
  onProgress?: (bytesWritten: number, totalBytes: number) => void
): Promise<void> {
  let existing = await existingSize(destPath)

  if (existing > part.size) {
    await rm(destPath, { force: true })
    existing = 0
  }

  if (existing < part.size) {
    const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {}
    const res = await fetch(part.url, { headers })
    if (!res.ok || !res.body) {
      throw new Error(`download failed: ${part.url} (status ${res.status})`)
    }

    const isPartialResponse = res.status === 206
    const resumingCleanly = existing > 0 && isPartialResponse
    const writeStream = createWriteStream(destPath, { flags: resumingCleanly ? 'a' : 'w' })

    let written = resumingCleanly ? existing : 0
    const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
    nodeStream.on('data', (chunk: Buffer) => {
      written += chunk.length
      onProgress?.(written, part.size)
    })
    await pipeline(nodeStream, writeStream)
  }

  const gotMd5 = await md5OfFile(destPath)
  if (gotMd5 !== part.md5) {
    await rm(destPath, { force: true })
    throw new DownloadVerificationError(part)
  }
}
