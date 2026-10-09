
import { join } from 'path'
import { mkdir, rm, readFile, appendFile, writeFile } from 'fs/promises'
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
  onProgress?: (processed: number, total: number) => void
): Promise<void> {
  await mkdir(partsDir, { recursive: true })

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const partPath = join(partsDir, `part-${i}`)
    await downloadPart({ url: part.url, md5: part.md5, size: Number(part.size) }, partPath)
    onProgress?.(i + 1, parts.length)
  }

  await writeFile(destZipPath, Buffer.alloc(0))
  for (let i = 0; i < parts.length; i++) {
    const partPath = join(partsDir, `part-${i}`)
    const data = await readFile(partPath)
    await appendFile(destZipPath, data)
  }

  await rm(partsDir, { recursive: true, force: true })
}
