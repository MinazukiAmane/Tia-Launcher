
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat, readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
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

export async function fetchVersionManifest(resListUrl: string | undefined): Promise<VersionManifest | null> {
  if (!resListUrl) return null
  try {
    const res = await fetch(resListUrl, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<VersionManifest>
    if (!Array.isArray(body.files)) return null
    if (body.files.some(file => !file || typeof file.path !== 'string' || typeof file.md5 !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0)) return null
    return { version: typeof body.version === 'string' ? body.version : '', files: body.files, repair_supported: body.repair_supported }
  } catch {
    return null
  }
}

async function md5OfFileStreaming(filePath: string): Promise<string> {
  const hash = createHash('md5')
  await pipeline(createReadStream(filePath, { highWaterMark: 1024 * 1024 }), hash)
  return hash.digest('hex')
}

export async function verifyAgainstManifest(
  installDir: string,
  manifest: { version?: string; files: { path: string; md5: string; size?: number }[] },
  quick = false
): Promise<VerifyResult> {
  const corruptFiles: string[] = []
  const missingFiles: string[] = []
  const cachePath = join(installDir, '.csore_verify_cache.json')
  let previous: Record<string, string> = {}
  if (quick) {
    try {
      const cached: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
      if (cached && typeof cached === 'object' && !Array.isArray(cached)) previous = cached as Record<string, string>
    } catch { /* first check */ }
  }
  const next: Record<string, string> = {}
  // The published package contains a legacy lowercase alias with a different hash.
  const hasCanonicalRenderer = manifest.files.some(entry => entry.path === 'Bin/Renderer.dll')
  // Validate the complete list before starting any disk work.
  const entries = manifest.files.map(entry => {
    if (!entry.path || entry.path.includes('\\') || entry.path.includes(':') || entry.path.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new Error('Invalid manifest file path')
    }
    const filePath = resolveWithinRoot(installDir, entry.path, 'manifest file', reason => { throw new Error(reason) })
    return { entry, filePath }
  }).filter(({ entry }) => !entry.path.toLowerCase().endsWith('.log') &&
    !(hasCanonicalRenderer && entry.path === 'Bin/renderer.dll'))
  // Bound metadata IO; hash one file at a time to avoid HDD seek contention.
  for (let offset = 0; offset < entries.length; offset += 4) {
    const batch = entries.slice(offset, offset + 4)
    const metadata = await Promise.allSettled(batch.map(({ filePath }) => stat(filePath)))
    for (let index = 0; index < batch.length; index++) {
      const { entry, filePath } = batch[index]
      const found = metadata[index]
      if (found.status === 'rejected') {
        if ((found.reason as NodeJS.ErrnoException).code === 'ENOENT') { missingFiles.push(entry.path); continue }
        throw found.reason
      }
      const info = found.value
      if (!info.isFile() || (entry.size !== undefined && info.size !== entry.size)) { corruptFiles.push(entry.path); continue }
      const stamp = JSON.stringify([entry.md5, info.size, info.mtimeMs, info.ctimeMs, info.ino, info.dev])
      if (quick && previous[entry.path] === stamp) { next[entry.path] = stamp; continue }
      if (await md5OfFileStreaming(filePath) !== entry.md5) { corruptFiles.push(entry.path); continue }
      const after = await stat(filePath)
      if (after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs && after.ino === info.ino && after.dev === info.dev) next[entry.path] = stamp
      else corruptFiles.push(entry.path)
    }
  }
  // Warm Play checks do not need to rewrite identical cache data.
  if (quick && JSON.stringify(previous) === JSON.stringify(next)) {
    return { ok: !corruptFiles.length && !missingFiles.length, corruptFiles, missingFiles }
  }
  try {
    const temp = cachePath + '.' + process.pid + '.tmp'
    await writeFile(temp, JSON.stringify(next))
    await rename(temp, cachePath)
  } catch { /* Cache failure must not prevent verification. */ }
  return { ok: !corruptFiles.length && !missingFiles.length, corruptFiles, missingFiles }
}
