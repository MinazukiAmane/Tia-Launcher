
import AdmZip from 'adm-zip'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { mkdtemp, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'

export interface ManifestEntry {
  path: string
  action: 'added' | 'modified' | 'removed'
  delta_file?: string
  old_md5?: string
  new_md5?: string
  size?: number
}

export interface Manifest {
  entries: ManifestEntry[]
}

export class PatchVerificationError extends Error {
  constructor(
    public readonly entry: ManifestEntry,
    reason: string
  ) {
    super(`patch verification failed for ${entry.path}: ${reason}`)
    this.name = 'PatchVerificationError'
  }
}

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

export function readManifest(patchZipPath: string): Manifest {
  const zip = new AdmZip(patchZipPath)
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('patch zip has no manifest.json')
  return JSON.parse(entry.getData().toString('utf-8')) as Manifest
}

export async function applyPatch(
  installDir: string,
  patchZipPath: string,
  manifest: Manifest,
  bspatch: (oldFile: Buffer, delta: Buffer) => Promise<Buffer>
): Promise<void> {
  const zip = new AdmZip(patchZipPath)
  const stagingDir = await mkdtemp(join(tmpdir(), 'csore-patch-staging-'))

  try {
    // Steps 3-4 of the doc: stage and verify every added/modified entry
    // BEFORE touching the live install at all.
    for (const entry of manifest.entries) {
      if (entry.action === 'removed') continue

      const stagedPath = join(stagingDir, entry.path)
      await mkdir(dirname(stagedPath), { recursive: true })

      if (entry.action === 'added') {
        const zipEntry = zip.getEntry(entry.path)
        if (!zipEntry) throw new PatchVerificationError(entry, `missing from patch zip: ${entry.path}`)
        await fs.writeFile(stagedPath, zipEntry.getData())
      } else if (entry.action === 'modified') {
        if (!entry.delta_file || !entry.old_md5) {
          throw new PatchVerificationError(entry, 'missing delta_file/old_md5 on a modified entry')
        }
        const livePath = join(installDir, entry.path)
        const oldBytes = await fs.readFile(livePath)
        const oldMd5 = md5(oldBytes)
        if (oldMd5 !== entry.old_md5) {
          throw new PatchVerificationError(
            entry,
            `installed file's MD5 (${oldMd5}) does not match old_md5 (${entry.old_md5}) -- stale or corrupted install`
          )
        }
        const deltaEntry = zip.getEntry(entry.delta_file)
        if (!deltaEntry) throw new PatchVerificationError(entry, `missing delta file: ${entry.delta_file}`)
        const newBytes = await bspatch(oldBytes, deltaEntry.getData())
        await fs.writeFile(stagedPath, newBytes)
      }

      const stagedBytes = await fs.readFile(stagedPath)
      const stagedMd5 = md5(stagedBytes)
      if (stagedMd5 !== entry.new_md5) {
        throw new PatchVerificationError(
          entry,
          `staged result's MD5 (${stagedMd5}) does not match new_md5 (${entry.new_md5})`
        )
      }
    }

    // Step 5: delete "removed" paths FIRST, then move staged files into place.
    const stagedPathsLower = new Set(
      manifest.entries.filter((e) => e.action !== 'removed').map((e) => e.path.toLowerCase())
    )
    for (const entry of manifest.entries) {
      if (entry.action !== 'removed') continue
      if (stagedPathsLower.has(entry.path.toLowerCase())) continue
      await fs.rm(join(installDir, entry.path), { force: true })
    }

    for (const entry of manifest.entries) {
      if (entry.action === 'removed') continue
      const stagedPath = join(stagingDir, entry.path)
      const livePath = join(installDir, entry.path)
      await mkdir(dirname(livePath), { recursive: true })
      await fs.copyFile(stagedPath, livePath)
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
