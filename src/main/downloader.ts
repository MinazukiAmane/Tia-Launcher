
import { createReadStream } from 'fs'
import { stat, rm, open } from 'fs/promises'
import { retryTransientFileAccess } from './fileAccess'
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

// Pausing preserves partial downloads and remains distinct from transfer failure.
export class DownloadPausedError extends Error {
  constructor(public readonly part: DownloadPart) {
    super(`download paused by caller: ${part.url}`)
    this.name = 'DownloadPausedError'
  }
}

async function existingSize(destPath: string): Promise<number> {
  try {
    return (await retryTransientFileAccess(() => stat(destPath))).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}

async function md5OfFile(path: string): Promise<string> {
  return retryTransientFileAccess(async () => {
    const hash = createHash('md5')
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex')
  })
}

// Abort only when data stops arriving; slow downloads remain valid.
const DOWNLOAD_TIMEOUT_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function downloadPartToFile(
  part: DownloadPart,
  destPath: string,
  onProgress?: (bytesWritten: number, totalBytes: number) => void,
  // Overridable only for tests: production always uses DOWNLOAD_TIMEOUT_MS.
  idleTimeoutMs: number = DOWNLOAD_TIMEOUT_MS,
  // Optional bytes-per-second limit; zero or undefined means unlimited.
  maxBytesPerSecond?: number,
  // Caller cancellation preserves the partial file for resume.
  externalSignal?: AbortSignal
): Promise<void> {
  let existing = await existingSize(destPath)

  if (existing > part.size) {
    await rm(destPath, { force: true })
    existing = 0
  }

  if (existing < part.size) {
    if (externalSignal?.aborted) {
      throw new DownloadPausedError(part)
    }

    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const armIdleTimeout = (): void => {
      clearTimeout(timeout)
      timeout = setTimeout(
        () => controller.abort(new Error(`download stalled (no data for ${idleTimeoutMs}ms): ${part.url}`)),
        idleTimeoutMs
      )
    }
    armIdleTimeout()

    // Abort only when data stops arriving; slow downloads remain valid.
    let pausedByCaller = false
    const onExternalAbort = (): void => {
      pausedByCaller = true
      controller.abort(new Error('download paused by caller'))
    }
    externalSignal?.addEventListener('abort', onExternalAbort)

    try {
      const headers: Record<string, string> = existing > 0 ? { Range: `bytes=${existing}-` } : {}
      const res = await fetch(part.url, { headers, signal: controller.signal })
      if (!res.ok || !res.body) {
        throw new Error(`download failed: ${part.url} (status ${res.status})`)
      }

      const isPartialResponse = res.status === 206
      const resumingCleanly = existing > 0 && isPartialResponse
      // Retry opening before consuming the response; never replay partial stream writes.
      const handle = await retryTransientFileAccess(() => open(destPath, resumingCleanly ? 'a' : 'w'))
      const writeStream = handle.createWriteStream()

      let written = resumingCleanly ? existing : 0

      let sizeExceeded = false
      const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)

      const rateStart = Date.now()
      let throttledBytesThisSession = 0
      // Keep throttling delays separate from network stalls.
      const idleKeepAliveStepMs = Math.max(50, Math.floor(idleTimeoutMs / 4))

      // Pace reads when the transfer exceeds the configured rate.
      async function pacedResume(delayMs: number): Promise<void> {
        let remaining = delayMs
        while (remaining > 0 && !nodeStream.destroyed) {
          const step = Math.min(remaining, idleKeepAliveStepMs)
          await sleep(step)
          armIdleTimeout()
          remaining -= step
        }
        if (!nodeStream.destroyed) nodeStream.resume()
      }

      nodeStream.on('data', (chunk: Buffer) => {
        armIdleTimeout()
        written += chunk.length
        onProgress?.(written, part.size)
        if (!sizeExceeded && written > part.size) {
          // Reject excess bytes before writing them to disk.
          sizeExceeded = true
          const err = new Error(
            `download exceeded declared size for ${part.url}: wrote ${written} bytes, expected at most ${part.size}`
          )
          nodeStream.destroy(err)
          controller.abort(err)
          return
        }

        if (maxBytesPerSecond && maxBytesPerSecond > 0) {
          throttledBytesThisSession += chunk.length
          const elapsedMs = Date.now() - rateStart
          const expectedMs = (throttledBytesThisSession / maxBytesPerSecond) * 1000
          const delayMs = expectedMs - elapsedMs
          if (delayMs > 0) {
            nodeStream.pause()
            void pacedResume(delayMs)
          }
        }
      })

      try {
        await pipeline(nodeStream, writeStream)
      } catch (err) {
        if (sizeExceeded) {
          await rm(destPath, { force: true })
        }
        throw err
      }
    } catch (err) {
      controller.abort(err)

      if (pausedByCaller) {
        throw new DownloadPausedError(part)
      }
      throw err
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      clearTimeout(timeout)
    }
  }

  const gotMd5 = await md5OfFile(destPath)
  if (gotMd5 !== part.md5) {
    await rm(destPath, { force: true })
    throw new DownloadVerificationError(part)
  }
}

// Include the local error code and path to distinguish disk failures from network failures.
export async function downloadPart(...args: Parameters<typeof downloadPartToFile>): Promise<void> {
  try {
    await downloadPartToFile(...args)
  } catch (error) {
    const local = error as NodeJS.ErrnoException
    if (['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES', 'ENOSPC', 'EIO', 'EROFS'].includes(local.code ?? '')) {
      const message = `Cannot access download file "${args[1]}" (${local.code}). Check free space, folder permissions, disk health, and antivirus/quarantine history. ${local.message}`
      throw Object.assign(new Error(message, { cause: error }), { code: local.code, path: local.path ?? args[1] })
    }
    throw error
  }
}
