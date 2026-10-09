
import AdmZip from 'adm-zip'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join, dirname, resolve, sep, isAbsolute, normalize } from 'path'
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
    reason: string,

    public readonly reasonCode: 'old_md5_mismatch' | 'other' = 'other'
  ) {
    super(`patch verification failed for ${entry.path}: ${reason}`)
    this.name = 'PatchVerificationError'
  }
}

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

// Bound manifest size before reading it into memory.
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024 // 10 MiB

const MAX_ENTRY_BYTES = 1024 * 1024 * 1024 // 1 GiB

// Reject absolute paths and parent traversal.
function assertSafeRelativePath(relPath: string, entry: ManifestEntry, label: string): void {
  if (isAbsolute(relPath)) {
    throw new PatchVerificationError(entry, `${label} must be a relative path, got an absolute path: ${relPath}`)
  }
  const segments = normalize(relPath).split(/[\\/]+/)
  if (segments.includes('..')) {
    throw new PatchVerificationError(entry, `${label} must not contain '..' path segments: ${relPath}`)
  }
}

// Reject resolved paths outside the installation root.
function resolveWithinRoot(root: string, relPath: string, entry: ManifestEntry, label: string): string {
  assertSafeRelativePath(relPath, entry, label)
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(resolvedRoot, relPath)
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new PatchVerificationError(entry, `${label} resolves outside of its root directory: ${relPath}`)
  }
  return resolvedTarget
}

function assertDeclaredSizeWithinCap(zipEntry: AdmZip.IZipEntry, entry: ManifestEntry, label: string): void {
  if (zipEntry.header.size > MAX_ENTRY_BYTES) {
    throw new PatchVerificationError(
      entry,
      `${label}'s declared decompressed size (${zipEntry.header.size} bytes) exceeds the ${MAX_ENTRY_BYTES}-byte ceiling -- refusing to decompress (possible zip bomb)`
    )
  }
}

function assertDeclaredSizeMatches(
  zipEntry: AdmZip.IZipEntry,
  expectedSize: number,
  entry: ManifestEntry,
  label: string
): void {
  if (zipEntry.header.size !== expectedSize) {
    throw new PatchVerificationError(
      entry,
      `${label}'s declared decompressed size (${zipEntry.header.size}) does not match the manifest's expected size (${expectedSize}) -- refusing to decompress (possible zip bomb)`
    )
  }
}

function assertActualSizeMatches(data: Buffer, expectedSize: number, entry: ManifestEntry, label: string): void {
  if (data.length !== expectedSize) {
    throw new PatchVerificationError(
      entry,
      `${label}'s decompressed size (${data.length}) does not match the manifest's expected size (${expectedSize})`
    )
  }
}

export function readManifest(patchZipPath: string): Manifest {
  const zip = new AdmZip(patchZipPath)
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('patch zip has no manifest.json')
  if (entry.header.size > MAX_MANIFEST_BYTES) {
    throw new Error(
      `manifest.json's declared decompressed size (${entry.header.size} bytes) exceeds the ${MAX_MANIFEST_BYTES}-byte ceiling -- refusing to decompress (possible zip bomb)`
    )
  }
  const data = entry.getData()
  if (data.length > MAX_MANIFEST_BYTES) {
    throw new Error(
      `manifest.json decompressed to an implausible size (${data.length} bytes) exceeding the ${MAX_MANIFEST_BYTES}-byte ceiling`
    )
  }
  return JSON.parse(data.toString('utf-8')) as Manifest
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

      // Reject unsafe paths before writing staged files.
      const stagedPath = resolveWithinRoot(stagingDir, entry.path, entry, 'path')
      if (entry.delta_file) assertSafeRelativePath(entry.delta_file, entry, 'delta_file')
      await mkdir(dirname(stagedPath), { recursive: true })

      if (entry.action === 'added') {
        const zipEntry = zip.getEntry(entry.path)
        if (!zipEntry) throw new PatchVerificationError(entry, `missing from patch zip: ${entry.path}`)
        assertDeclaredSizeWithinCap(zipEntry, entry, 'content')
        if (entry.size !== undefined) assertDeclaredSizeMatches(zipEntry, entry.size, entry, 'content')
        const data = zipEntry.getData()
        if (entry.size !== undefined) assertActualSizeMatches(data, entry.size, entry, 'content')
        await fs.writeFile(stagedPath, data)
      } else if (entry.action === 'modified') {
        if (!entry.delta_file || !entry.old_md5) {
          throw new PatchVerificationError(entry, 'missing delta_file/old_md5 on a modified entry')
        }

        const livePath = resolveWithinRoot(installDir, entry.path, entry, 'path')
        const oldBytes = await fs.readFile(livePath)
        const oldMd5 = md5(oldBytes)
        if (oldMd5 !== entry.old_md5) {
          throw new PatchVerificationError(
            entry,
            `installed file's MD5 (${oldMd5}) does not match old_md5 (${entry.old_md5}) -- stale or corrupted install`,
            'old_md5_mismatch'
          )
        }
        const deltaEntry = zip.getEntry(entry.delta_file)
        if (!deltaEntry) throw new PatchVerificationError(entry, `missing delta file: ${entry.delta_file}`)
        assertDeclaredSizeWithinCap(deltaEntry, entry, 'delta_file')
        const deltaBuf = deltaEntry.getData()
        if (deltaBuf.length > MAX_ENTRY_BYTES) {
          throw new PatchVerificationError(
            entry,
            `delta_file's actual decompressed size (${deltaBuf.length}) exceeds the ${MAX_ENTRY_BYTES}-byte ceiling -- refusing to apply (possible zip bomb)`
          )
        }
        const newBytes = await bspatch(oldBytes, deltaBuf)
        if (entry.size !== undefined) assertActualSizeMatches(newBytes, entry.size, entry, 'bspatch result')
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
      const livePath = resolveWithinRoot(installDir, entry.path, entry, 'path')
      await fs.rm(livePath, { force: true })
    }

    for (const entry of manifest.entries) {
      if (entry.action === 'removed') continue
      const stagedPath = resolveWithinRoot(stagingDir, entry.path, entry, 'path')
      const livePath = resolveWithinRoot(installDir, entry.path, entry, 'path')
      await mkdir(dirname(livePath), { recursive: true })
      await fs.copyFile(stagedPath, livePath)
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
