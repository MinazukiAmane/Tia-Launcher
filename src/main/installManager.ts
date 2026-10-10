
import { join } from 'path'
import { mkdir, rm } from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import type { GamePackageEntry, PkgEntry, VersionBlock } from './launcherApi'
import type { InstallState } from './installState'
import { downloadPart } from './downloader'

export type InstallAction =
  | { kind: 'fresh_install'; target: VersionBlock }
  | { kind: 'apply_patch'; patch: VersionBlock; toVersion: string }
  | { kind: 'up_to_date' }

export function decideAction(info: GamePackageEntry, state: InstallState | null): InstallAction {
  const major = info.main.major
  if (!major) throw new Error('no published main version available for this game')

  if (!state) return { kind: 'fresh_install', target: major }
  if (state.version === major.version) return { kind: 'up_to_date' }

  const patch = info.main.patches.find((p) => p.version === state.version)
  if (patch) return { kind: 'apply_patch', patch, toVersion: major.version }

  return { kind: 'fresh_install', target: major }
}

export async function reassembleParts(
  parts: PkgEntry[],
  destZipPath: string,
  partsDir: string,
  onProgress?: (processed: number, total: number) => void,

  maxBytesPerSecond?: number,
  // Optional pause/cancellation signal, forwarded unchanged to every downloadPart call below.
  externalSignal?: AbortSignal
): Promise<void> {
  await mkdir(partsDir, { recursive: true })

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const partPath = join(partsDir, `part-${i}`)
    await downloadPart(
      { url: part.url, md5: part.md5, size: Number(part.size) },
      partPath,
      undefined,
      undefined,
      maxBytesPerSecond,
      externalSignal
    )
    onProgress?.(i + 1, parts.length)
  }

  const destStream = createWriteStream(destZipPath, { flags: 'w' })
  for (let i = 0; i < parts.length; i++) {
    const partPath = join(partsDir, `part-${i}`)
    // Keep the destination stream open between parts.
    await pipeline(createReadStream(partPath), destStream, { end: false })
  }
  await new Promise<void>((resolve, reject) => {
    destStream.on('finish', resolve)
    destStream.on('error', reject)
    destStream.end()
  })

  await rm(partsDir, { recursive: true, force: true })
}
