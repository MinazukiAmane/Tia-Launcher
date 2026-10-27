import { activeGame } from './activeGame'
import { availableParallelism } from 'node:os'
import { VerificationWorkers, mapBounded } from './verificationWorkers'

import { createHash } from 'crypto'
import { createReadStream, type Stats } from 'fs'
import { stat } from 'fs/promises'
import { readGameRecord, writeRecords, gameScope } from './localDatabase'
import { pipeline } from 'stream/promises'
import { resolveWithinRoot } from './pathSafety'
import type { GamePackageEntry, VersionBlock } from './launcherApi'
import type { VerifyResult } from './gameManager'

export interface ManifestFileEntry {
  path: string
  md5: string
  size: number
  url?: string
}

export interface VersionManifest {
  version: string
  files: ManifestFileEntry[]
  repair_supported?: boolean
}

export function findVersionBlock(info: GamePackageEntry, installedVersion: string): VersionBlock | null {
  if (info.main.major && info.main.major.version === installedVersion) return info.main.major
  return info.main.patches.find((p) => p.version === installedVersion) ?? null
}

const recentManifests = new Map<string, { at: number; manifest: VersionManifest }>()

export async function fetchVersionManifest(resListUrl: string | undefined, timeoutMs = 10_000, forPlay = false): Promise<VersionManifest | null> {
  if (!resListUrl) return null
  const recent = recentManifests.get(resListUrl)
  if (forPlay && recent && Date.now() - recent.at < 30_000) return structuredClone(recent.manifest)
  try {
    const res = await fetch(resListUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<VersionManifest>
    if (!Array.isArray(body.files)) return null
    if (body.files.some(file => !file || typeof file.path !== 'string' || typeof file.md5 !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0)) return null
    const manifest = { version: typeof body.version === 'string' ? body.version : '', files: body.files, repair_supported: body.repair_supported }
    if (recentManifests.size >= 16) recentManifests.delete(recentManifests.keys().next().value!)
    recentManifests.set(resListUrl, { at: Date.now(), manifest: structuredClone(manifest) })
    return manifest
  } catch {
    return null
  }
}

async function md5OfFileStreaming(filePath: string): Promise<string> {
  const hash = createHash('md5')
  await pipeline(createReadStream(filePath, { highWaterMark: 64 * 1024 }), hash)
  return hash.digest('hex')
}

export interface VerifyMetrics {
  durationMs: number
  files: number
  cacheHits: number
  hashedFiles: number
  hashedBytes: number
}

export interface VerifyOptions {
  /** Defaults to two hash workers; one is useful on storage with costly seeks. */
  hashConcurrency?: number
  onMetrics?: (metrics: VerifyMetrics) => void
}

export async function verifyAgainstManifest(
  installDir: string,
  manifest: { version?: string; files: { path: string; md5: string; size?: number }[] },
  quick = false,
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  const started = performance.now()
  let cacheHits = 0
  let hashedFiles = 0
  let hashedBytes = 0
  const corruptFiles: string[] = []
  const missingFiles: string[] = []
  let previous: Record<string, string> = {}
  if (quick) {
    try {
      const cached: unknown = await readGameRecord(installDir, 'verifyCache')
      if (cached && typeof cached === 'object' && !Array.isArray(cached)) previous = cached as Record<string, string>
    } catch { /* first check */ }
  }
  const next: Record<string, string> = {}
  // The published package contains a legacy uppercase alias with a different hash.
  const hasCanonicalRenderer = manifest.files.some(entry => entry.path === 'Bin/renderer.dll')
  // Validate the complete list before starting any disk work.
  const entries = manifest.files.map(entry => {
    if (!entry.path || entry.path.includes('\\') || entry.path.includes(':') || entry.path.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new Error('Invalid manifest file path')
    }
    const filePath = resolveWithinRoot(installDir, entry.path, 'manifest file', reason => { throw new Error(reason) })
    return { entry, filePath }
  }).filter(({ entry }) => {
    const path = entry.path.toLowerCase()
    if (path.endsWith('.log')) return false
    // UE runtime state is mutable, including when accidentally shipped in a
    // package. Keep Content, Config, executables and plugins fully verified.
    if (activeGame().biz === 'cedar_global' &&
        /^(?:(?:silverpalace|engine)\/saved\/|(?:(?:silverpalace|engine)\/)?deriveddatacache\/)/.test(path)) return false
    return !(hasCanonicalRenderer && entry.path === 'Bin/Renderer.dll')
  })
  // Metadata and content IO have separate bounds. Hashing occurs in lazy Node
  // workers so a cold/manual check does not monopolize Electron's main thread.
  const requested = options.hashConcurrency ?? Math.min(2, Math.max(1, availableParallelism() - 1))
  if (!Number.isInteger(requested) || requested < 1 || requested > 4) throw new Error('Invalid hash concurrency.')
  const workers = new VerificationWorkers(requested)
  type Checked = { kind: 'good'; stamp: string } | { kind: 'missing' } | { kind: 'corrupt' }
  const results: Checked[] = new Array(entries.length)
  const pending: { index: number; stamp: string; info: Stats }[] = []
  try {
    // Batched stat avoids both one-at-a-time syscalls and per-file promise chains
    // on a warm Play check. Only changed files enter the content-work queue.
    for (let offset = 0; offset < entries.length; offset += 32) {
      const batch = entries.slice(offset, offset + 32)
      const metadata = await Promise.allSettled(batch.map(({ filePath }) => stat(filePath)))
      for (let i = 0; i < batch.length; i++) {
        const index = offset + i
        const { entry } = batch[i]
        const found = metadata[i]
        if (found.status === 'rejected') {
          if ((found.reason as NodeJS.ErrnoException).code === 'ENOENT') { results[index] = { kind: 'missing' }; continue }
          throw found.reason
        }
        const info = found.value
        if (!info.isFile() || (entry.size !== undefined && info.size !== entry.size)) { results[index] = { kind: 'corrupt' }; continue }
        const stamp = JSON.stringify([entry.md5, info.size, info.mtimeMs, info.ctimeMs, info.ino, info.dev])
        if (quick && previous[entry.path] === stamp) { cacheHits++; results[index] = { kind: 'good', stamp }; continue }
        pending.push({ index, stamp, info })
      }
    }
    await mapBounded(pending, 8, async ({ index, stamp, info }) => {
      const { entry, filePath } = entries[index]
      try {
        // Tiny files do not pay worker messaging overhead. Large file hashes
        // always leave the main thread, even when it is the only file.
        hashedFiles++
        hashedBytes += info.size
        const digest = info.size < 256 * 1024
          ? await md5OfFileStreaming(filePath) : await workers.hash(filePath)
        if (digest !== entry.md5) { results[index] = { kind: 'corrupt' }; return }
        const after = await stat(filePath)
        results[index] = after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.ino !== info.ino || after.dev !== info.dev
          ? { kind: 'corrupt' } : { kind: 'good', stamp }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { results[index] = { kind: 'missing' }; return }
        throw error
      }
    })
  } finally { await workers.close() }
  // Keep results/cache in manifest order, independent of worker finish order.
  for (let index = 0; index < entries.length; index++) {
    const result = results[index]
    const path = entries[index].entry.path
    if (result.kind === 'missing') missingFiles.push(path)
    else if (result.kind === 'corrupt') corruptFiles.push(path)
    else next[path] = result.stamp
  }
  options.onMetrics?.({ durationMs: Math.round(performance.now() - started), files: entries.length, cacheHits, hashedFiles, hashedBytes })
  // Warm Play checks do not need to rewrite identical cache data.
  if (quick && JSON.stringify(previous) === JSON.stringify(next)) {
    return { ok: !corruptFiles.length && !missingFiles.length, corruptFiles, missingFiles }
  }
  try {
    writeRecords(gameScope(installDir), { verifyCache: next }, undefined, false)
  } catch { /* Cache failure must not prevent verification. */ }
  return { ok: !corruptFiles.length && !missingFiles.length, corruptFiles, missingFiles }
}
