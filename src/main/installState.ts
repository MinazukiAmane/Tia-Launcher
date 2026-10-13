
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ManifestEntry } from './patcher'
import type { PkgEntry } from './launcherApi'

export interface InstalledFileEntry {
  path: string
  md5: string
}

export interface InstallState {
  version: string
  installDir: string
  files: InstalledFileEntry[]
  // Imported files are a repair target until verified against server hashes.
  needsRepair?: boolean
}

const STATE_FILENAME = '.csore_install.json'

export function installStatePath(installDir: string): string {
  return join(installDir, STATE_FILENAME)
}

export async function readInstallState(installDir: string): Promise<InstallState | null> {
  try {
    const raw = await fs.readFile(installStatePath(installDir), 'utf-8')
    return JSON.parse(raw) as InstallState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeInstallState(installDir: string, state: InstallState): Promise<void> {
  await fs.writeFile(installStatePath(installDir), JSON.stringify(state, null, 2), 'utf-8')
}

export interface PendingAudioPatch {
  toVersion: string
  audioPkgs: PkgEntry[]
}

const PENDING_AUDIO_PATCH_FILENAME = '.csore_pending_audio_patch.json'

export function pendingAudioPatchPath(installDir: string): string {
  return join(installDir, PENDING_AUDIO_PATCH_FILENAME)
}

export async function readPendingAudioPatch(installDir: string): Promise<PendingAudioPatch | null> {
  try {
    const raw = await fs.readFile(pendingAudioPatchPath(installDir), 'utf-8')
    return JSON.parse(raw) as PendingAudioPatch
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writePendingAudioPatch(installDir: string, data: PendingAudioPatch): Promise<void> {
  await fs.writeFile(pendingAudioPatchPath(installDir), JSON.stringify(data, null, 2), 'utf-8')
}

export async function clearPendingAudioPatch(installDir: string): Promise<void> {
  await fs.rm(pendingAudioPatchPath(installDir), { force: true })
}

export function mergeManifestEntries(
  previousFiles: InstalledFileEntry[],
  entries: ManifestEntry[]
): InstalledFileEntry[] {
  const removedPaths = new Set(entries.filter((e) => e.action === 'removed').map((e) => e.path))
  const upserts = new Map<string, string>()
  for (const entry of entries) {
    if (entry.action === 'added' || entry.action === 'modified') {
      upserts.set(entry.path, entry.new_md5!)
    }
  }

  const result: InstalledFileEntry[] = []
  const seen = new Set<string>()

  for (const file of previousFiles) {
    if (removedPaths.has(file.path)) continue
    if (upserts.has(file.path)) {
      result.push({ path: file.path, md5: upserts.get(file.path)! })
    } else {
      result.push(file)
    }
    seen.add(file.path)
  }

  for (const [path, md5] of upserts) {
    if (!seen.has(path)) result.push({ path, md5 })
  }

  return result
}
