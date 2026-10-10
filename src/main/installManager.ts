
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import type { GamePackageEntry, PkgEntry, VersionBlock } from './launcherApi'
import type { InstallState, PendingAudioPatch } from './installState'
import { downloadPart, DownloadPausedError } from './downloader'
import { logInfo, logDebug } from './logger'

export type InstallAction =
  | { kind: 'fresh_install'; target: VersionBlock }
  | { kind: 'apply_patch'; patch: VersionBlock; toVersion: string }

  | { kind: 'resume_audio_patch'; pending: PendingAudioPatch }
  | { kind: 'up_to_date' }

export function decideAction(
  info: GamePackageEntry,
  state: InstallState | null,
  pendingAudioPatch: PendingAudioPatch | null = null
): InstallAction {
  if (pendingAudioPatch && state && state.version === pendingAudioPatch.toVersion) {
    return { kind: 'resume_audio_patch', pending: pendingAudioPatch }
  }

  const major = info.main.major
  if (!major) throw new Error('no published main version available for this game')

  if (!state) return { kind: 'fresh_install', target: major }
  if (state.version === major.version) return { kind: 'up_to_date' }

  const patch = info.main.patches.find((p) => p.version === state.version)
  if (patch) return { kind: 'apply_patch', patch, toVersion: major.version }

  return { kind: 'fresh_install', target: major }
}

// Retry policy for a single part's download (see downloadPartWithRetry below).
export interface PartRetryOptions {
  maxAttempts?: number

  baseDelayMs?: number

  maxDelayMs?: number
}

const DEFAULT_RETRY_OPTIONS: Required<PartRetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 30_000
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timeout)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Retry transient part-download failures with exponential backoff.
async function downloadPartWithRetry(
  part: { url: string; md5: string; size: number },
  partPath: string,
  maxBytesPerSecond: number | undefined,
  externalSignal: AbortSignal | undefined,
  retryOptions: Required<PartRetryOptions>,
  idleTimeoutMs?: number,
  onBytes?: (bytesWritten: number) => void
): Promise<void> {
  let attempt = 0
  for (;;) {
    attempt++
    try {
      await downloadPart(part, partPath, onBytes, idleTimeoutMs, maxBytesPerSecond, externalSignal)
      return
    } catch (err) {
      if (err instanceof DownloadPausedError) throw err

      if (attempt >= retryOptions.maxAttempts) {
        logInfo('reassembleParts: part download failed, retries exhausted', {
          url: part.url,
          attempt,
          maxAttempts: retryOptions.maxAttempts,
          error: (err as Error).message
        })
        throw err
      }

      const delayMs = Math.min(retryOptions.baseDelayMs * 2 ** (attempt - 1), retryOptions.maxDelayMs)
      logInfo('reassembleParts: part download failed, retrying after backoff', {
        url: part.url,
        attempt,
        maxAttempts: retryOptions.maxAttempts,
        delayMs,
        error: (err as Error).message
      })
      await abortableSleep(delayMs, externalSignal)
    }
  }
}

export async function reassembleParts(
  parts: PkgEntry[],
  destZipPath: string,
  partsDir: string,

  onProgress?: (processed: number, total: number) => void,

  maxBytesPerSecond?: number,
  // Optional pause/cancellation signal, forwarded unchanged to every downloadPart call below.
  externalSignal?: AbortSignal,
  // Abort only when data stops arriving; slow downloads remain valid.
  retryOptions?: PartRetryOptions,
  idleTimeoutMsOverride?: number
): Promise<void> {
  const effectiveRetryOptions: Required<PartRetryOptions> = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions }
  await mkdir(partsDir, { recursive: true })

  const totalBytes = parts.reduce((sum, p) => sum + Number(p.size), 0)
  let completedBytes = 0
  let lastEmit = 0
  onProgress?.(0, totalBytes)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const partSize = Number(part.size)
    const partPath = join(partsDir, `part-${part.md5}`)
    logDebug('reassembleParts: starting part download', { url: part.url, index: i, total: parts.length })
    await downloadPartWithRetry(
      { url: part.url, md5: part.md5, size: Number(part.size) },
      partPath,
      maxBytesPerSecond,
      externalSignal,
      effectiveRetryOptions,
      idleTimeoutMsOverride,
      (written) => {
        const now = Date.now()
        if (now - lastEmit < 250) return
        lastEmit = now
        onProgress?.(completedBytes + Math.min(written, partSize), totalBytes)
      }
    )
    completedBytes += partSize
    lastEmit = Date.now()
    onProgress?.(completedBytes, totalBytes)
  }

  const destStream = createWriteStream(destZipPath, { flags: 'w' })
  for (let i = 0; i < parts.length; i++) {
    const partPath = join(partsDir, `part-${parts[i].md5}`)
    // Keep the destination stream open between parts.
    await pipeline(createReadStream(partPath), destStream, { end: false })
  }
  await new Promise<void>((resolve, reject) => {
    destStream.on('finish', resolve)
    destStream.on('error', reject)
    destStream.end()
  })

}
