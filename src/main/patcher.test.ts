
import { describe, it, expect, afterEach } from 'vitest'
import AdmZip from 'adm-zip'
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'fs/promises'
import { readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { readManifest, applyPatch, PatchVerificationError, type Manifest } from './patcher'

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

const fakeBspatch = async (oldFile: Buffer, delta: Buffer): Promise<Buffer> => {
  return Buffer.concat([oldFile, delta])
}

let tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-patcher-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('readManifest', () => {
  it('reads entries out of manifest.json inside the patch zip', async () => {
    const dir = await makeTempDir()
    const zip = new AdmZip()
    const manifest: Manifest = { entries: [{ path: 'a.txt', action: 'added', new_md5: 'x', size: 1 }] }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    await expect(readManifest(zipPath)).resolves.toEqual(manifest)
  })
})

describe('applyPatch', () => {
  it('stages, verifies, and commits an "added" entry', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(installDir, { recursive: true })

    const addedContent = Buffer.from('brand new file')
    const zip = new AdmZip()
    const manifest: Manifest = {
      entries: [{ path: 'Data/new.txt', action: 'added', new_md5: md5(addedContent), size: addedContent.length }]
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    zip.addFile('Data/new.txt', addedContent)
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    await applyPatch(installDir, zipPath, manifest, fakeBspatch)

    const got = await readFile(join(installDir, 'Data/new.txt'))
    expect(got.equals(addedContent)).toBe(true)
  })

  it('stages, verifies old_md5, applies bspatch, and commits a "modified" entry', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(join(installDir, 'Bin'), { recursive: true })

    const oldContent = Buffer.from('old bytes')
    const deltaSuffix = Buffer.from(' plus delta suffix')
    const newContent = Buffer.concat([oldContent, deltaSuffix]) // matches fakeBspatch's behavior
    await writeFile(join(installDir, 'Bin/client.dll'), oldContent)

    const zip = new AdmZip()
    const manifest: Manifest = {
      entries: [
        {
          path: 'Bin/client.dll',
          action: 'modified',
          delta_file: 'deltas/0001.bsdiff',
          old_md5: md5(oldContent),
          new_md5: md5(newContent)
        }
      ]
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    zip.addFile('deltas/0001.bsdiff', deltaSuffix) // fakeBspatch just appends this
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    await applyPatch(installDir, zipPath, manifest, fakeBspatch)

    const got = await readFile(join(installDir, 'Bin/client.dll'))
    expect(got.equals(newContent)).toBe(true)
  })

  it('removes a "removed" entry', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(installDir, { recursive: true })
    await writeFile(join(installDir, 'old.dll'), 'stale')

    const zip = new AdmZip()
    const manifest: Manifest = { entries: [{ path: 'old.dll', action: 'removed' }] }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    await applyPatch(installDir, zipPath, manifest, fakeBspatch)

    await expect(access(join(installDir, 'old.dll'))).rejects.toThrow()
  })

  it('throws PatchVerificationError and leaves the live install untouched when old_md5 does not match (stale/corrupted local file)', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(installDir, { recursive: true })
    await mkdir(join(installDir, 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Bin/client.dll'), 'WRONG old content, not what manifest expects')

    const zip = new AdmZip()
    const manifest: Manifest = {
      entries: [
        {
          path: 'Bin/client.dll',
          action: 'modified',
          delta_file: 'deltas/0001.bsdiff',
          old_md5: 'expected-md5-that-will-not-match',
          new_md5: 'irrelevant'
        }
      ]
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    zip.addFile('deltas/0001.bsdiff', Buffer.from('irrelevant'))
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    const before = await readFile(join(installDir, 'Bin/client.dll'));
    await expect(applyPatch(installDir, zipPath, manifest, fakeBspatch)).rejects.toBeInstanceOf(PatchVerificationError)

    const after = await readFile(join(installDir, 'Bin/client.dll'))
    expect(after.equals(before)).toBe(true) // untouched -- the whole point of stage-then-commit
  })

  it('deletes a case-only-renamed "removed" path only after staging the "added" replacement, never losing the file (Windows case-insensitivity hazard)', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(installDir, { recursive: true })
    await writeFile(join(installDir, 'Client.dll'), 'original content')

    const newContent = Buffer.from('original content') // same bytes, just a rename -- plausible real case
    const zip = new AdmZip()
    const manifest: Manifest = {
      entries: [
        { path: 'client.dll', action: 'added', new_md5: md5(newContent), size: newContent.length },
        { path: 'Client.dll', action: 'removed' }
      ]
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    zip.addFile('client.dll', newContent)
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    await applyPatch(installDir, zipPath, manifest, fakeBspatch)

    const got = await readFile(join(installDir, 'client.dll'))
    expect(got.equals(newContent)).toBe(true)
  })

  it('rejects a manifest entry whose path escapes the install/staging root (path traversal)', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(installDir, { recursive: true })

    const maliciousContent = Buffer.from('pwned')
    const traversalPath = '../../escape.txt'
    const manifest: Manifest = {
      entries: [
        { path: traversalPath, action: 'added', new_md5: md5(maliciousContent), size: maliciousContent.length }
      ]
    }

    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    zip.addFile('placeholder.txt', maliciousContent)

    const placeholderEntry = zip.getEntries().find((e) => e.entryName === 'placeholder.txt')
    if (!placeholderEntry) throw new Error('test setup: placeholder entry not found')
    placeholderEntry.entryName = traversalPath
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    const escapedPath = resolve(installDir, traversalPath)

    await expect(applyPatch(installDir, zipPath, manifest, fakeBspatch)).rejects.toBeInstanceOf(
      PatchVerificationError
    )
    await expect(access(escapedPath)).rejects.toThrow()
  })

  it('rejects a manifest entry with an absolute path', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(installDir, { recursive: true })

    const zip = new AdmZip()
    const manifest: Manifest = {
      entries: [{ path: '/etc/evil.txt', action: 'added', new_md5: 'irrelevant', size: 5 }]
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    await expect(applyPatch(installDir, zipPath, manifest, fakeBspatch)).rejects.toBeInstanceOf(
      PatchVerificationError
    )
    await expect(access('/etc/evil.txt')).rejects.toThrow()
  })

  it('rejects an entry whose manifest-declared size is smaller than the zip entry\'s actual decompressed content (zip-bomb guard)', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    await mkdir(installDir, { recursive: true })

    const actualContent = Buffer.alloc(10_000, 'A')
    const zip = new AdmZip()
    const manifest: Manifest = {
      entries: [{ path: 'Data/big.txt', action: 'added', new_md5: md5(actualContent), size: 5 }]
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
    zip.addFile('Data/big.txt', actualContent)
    const zipPath = join(dir, 'patch.zip')
    zip.writeZip(zipPath)

    await expect(applyPatch(installDir, zipPath, manifest, fakeBspatch)).rejects.toBeInstanceOf(
      PatchVerificationError
    )
    await expect(access(join(installDir, 'Data/big.txt'))).rejects.toThrow()
  })
})

describe('openZip file descriptor handling (fd leak fix)', () => {
  const canCountFds = process.platform === 'linux' && existsSync('/proc/self/fd')

  function countOpenFds(): number {
    return readdirSync('/proc/self/fd').length
  }

  it.runIf(canCountFds)(
    'does not leak a file descriptor on repeated readManifest failures against a zip with an unsafe entry name',
    async () => {
      const dir = await makeTempDir()
      const zip = new AdmZip()
      zip.addFile('manifest.json', Buffer.from(JSON.stringify({ entries: [] })))
      zip.addFile('placeholder.txt', Buffer.from('x'))

      const placeholderEntry = zip.getEntries().find((e) => e.entryName === 'placeholder.txt')
      if (!placeholderEntry) throw new Error('test setup: placeholder entry not found')
      placeholderEntry.entryName = '../escape.txt'
      const zipPath = join(dir, 'malformed.zip')
      zip.writeZip(zipPath)

      const before = countOpenFds()
      for (let i = 0; i < 20; i++) {
        await expect(readManifest(zipPath)).rejects.toThrow()
      }
      const after = countOpenFds()

      expect(after - before).toBeLessThanOrEqual(2)
    }
  )

  it.runIf(canCountFds)(
    'does not leak a file descriptor on repeated applyPatch failures when the zip contains an unreferenced entry with an unsafe name',
    async () => {
      const dir = await makeTempDir()
      const installDir = join(dir, 'install')
      await mkdir(installDir, { recursive: true })

      const content = Buffer.from('safe content')
      const manifest: Manifest = {
        entries: [{ path: 'a.txt', action: 'added', new_md5: md5(content), size: content.length }]
      }
      const zip = new AdmZip()
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
      zip.addFile('a.txt', content)
      zip.addFile('placeholder.txt', Buffer.from('x'))
      const placeholderEntry = zip.getEntries().find((e) => e.entryName === 'placeholder.txt')
      if (!placeholderEntry) throw new Error('test setup: placeholder entry not found')
      placeholderEntry.entryName = '../escape.txt'
      const zipPath = join(dir, 'malformed-patch.zip')
      zip.writeZip(zipPath)

      const before = countOpenFds()
      for (let i = 0; i < 20; i++) {
        await expect(applyPatch(installDir, zipPath, manifest, fakeBspatch)).rejects.toThrow()
      }
      const after = countOpenFds()

      expect(after - before).toBeLessThanOrEqual(2)
    }
  )
})
