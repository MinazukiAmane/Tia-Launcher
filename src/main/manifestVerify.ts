
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import type { GamePackageEntry, VersionBlock } from './launcherApi'
import type { VerifyResult } from './gameManager'

export interface ManifestFileEntry {
  path: string
  md5: string
  size: number
}

export interface VersionManifest {
  version: string
  files: ManifestFileEntry[]
}

export function findVersionBlock(info: GamePackageEntry, installedVersion: string): VersionBlock | null {
  if (info.main.major && info.main.major.version === installedVersion) return info.main.major
  return info.main.patches.find((p) => p.version === installedVersion) ?? null
}

export async function fetchVersionManifest(resListUrl: string | undefined): Promise<VersionManifest | null> {
  if (!resListUrl) return null
  try {
    const res = await fetch(resListUrl)
    if (!res.ok) return null
    const body = (await res.json()) as Partial<VersionManifest>
    if (!Array.isArray(body.files)) return null
    return { version: typeof body.version === 'string' ? body.version : '', files: body.files }
  } catch {
    return null
  }
}

async function md5OfFileStreaming(filePath: string): Promise<string> {
  const hash = createHash('md5')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

export async function verifyAgainstManifest(installDir: string, manifest: VersionManifest): Promise<VerifyResult> {
  const corruptFiles: string[] = []
  const missingFiles: string[] = []

  for (const entry of manifest.files) {
    const filePath = join(installDir, entry.path)
    let size: number
    try {
      size = (await stat(filePath)).size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        missingFiles.push(entry.path)
        continue
      }
      throw err
    }
    if (size !== entry.size) {
      corruptFiles.push(entry.path)
      continue
    }
    const actualMd5 = await md5OfFileStreaming(filePath)
    if (actualMd5 !== entry.md5) {
      corruptFiles.push(entry.path)
    }
  }

  return { ok: corruptFiles.length === 0 && missingFiles.length === 0, corruptFiles, missingFiles }
}
