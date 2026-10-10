
import { describe, it, expect, afterEach, vi } from 'vitest'
import AdmZip from 'adm-zip'
import fs from 'fs'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { extractZip } from './zipExtract'

function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

let tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-zipextract-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('extractZip', () => {
  it('extracts a modestly large entry (~40 MiB) and nested directories without ever calling readFileSync/fs.promises.readFile on the zip', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')

    const bigContent = Buffer.alloc(40 * 1024 * 1024)
    for (let i = 0; i < bigContent.length; i++) bigContent[i] = i % 256
    const smallContent = Buffer.from('a small nested file')

    const zip = new AdmZip()
    zip.addFile('Bin/big.bin', bigContent)
    zip.addFile('Data/Nested/Deep/small.txt', smallContent)
    const zipPath = join(dir, 'client.zip')
    zip.writeZip(zipPath)

    // Spy on the exact APIs that previously caused ERR_FS_FILE_TOO_LARGE via adm-zip's constructor.
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync')
    const readFileSpy = vi.spyOn(fs.promises, 'readFile')

    const result = await extractZip(zipPath, installDir)

    const extractedBig = await readFile(join(installDir, 'Bin', 'big.bin'))
    expect(md5(extractedBig)).toBe(md5(bigContent))
    const extractedSmall = await readFile(join(installDir, 'Data', 'Nested', 'Deep', 'small.txt'))
    expect(extractedSmall.equals(smallContent)).toBe(true)

    expect(result).toHaveLength(2)
    const byPath = new Map(result.map((f) => [f.path, f.md5]))
    expect(byPath.get('Bin/big.bin')).toBe(md5(bigContent))
    expect(byPath.get('Data/Nested/Deep/small.txt')).toBe(md5(smallContent))

    const allCalls = [...readFileSyncSpy.mock.calls, ...readFileSpy.mock.calls]
    const calledWithZipPath = allCalls.some((args) => args[0] === zipPath)
    expect(calledWithZipPath).toBe(false)
  })

  it('rejects a zip entry that resolves outside the destination directory (path traversal) and does not create the escaped file', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')

    const maliciousContent = Buffer.from('pwned')
    const traversalName = '../../escape.txt'

    const zip = new AdmZip()
    zip.addFile('placeholder.txt', maliciousContent)

    const placeholderEntry = zip.getEntries().find((e) => e.entryName === 'placeholder.txt')
    if (!placeholderEntry) throw new Error('test setup: placeholder entry not found')
    placeholderEntry.entryName = traversalName
    const zipPath = join(dir, 'malicious.zip')
    zip.writeZip(zipPath)

    const escapedPath = resolve(installDir, traversalName)

    await expect(extractZip(zipPath, installDir)).rejects.toThrow()
    await expect(readFile(escapedPath)).rejects.toThrow()
  })

  it('rejects a zip entry with an absolute path', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')

    const zip = new AdmZip()
    zip.addFile('placeholder.txt', Buffer.from('x'))
    const placeholderEntry = zip.getEntries().find((e) => e.entryName === 'placeholder.txt')
    if (!placeholderEntry) throw new Error('test setup: placeholder entry not found')
    placeholderEntry.entryName = '/etc/evil.txt'
    const zipPath = join(dir, 'malicious-absolute.zip')
    zip.writeZip(zipPath)

    await expect(extractZip(zipPath, installDir)).rejects.toThrow()
    await expect(readFile('/etc/evil.txt')).rejects.toThrow()
  })
})

describe('extractZip progress', () => {
  it('reports entries done/total, ending at the full entry count', async () => {
    const dir = await makeTempDir()
    const zip = new AdmZip()
    for (let i = 0; i < 5; i++) zip.addFile(`d/f${i}.txt`, Buffer.from(`file ${i}`))
    const zipPath = join(dir, 'in.zip')
    zip.writeZip(zipPath)

    const updates: Array<[number, number]> = []
    const files = await extractZip(zipPath, join(dir, 'out'), (done, total) => updates.push([done, total]))

    expect(files).toHaveLength(5)
    expect(updates.length).toBeGreaterThanOrEqual(1)
    const last = updates[updates.length - 1]
    expect(last[0]).toBe(last[1])
    expect(last[1]).toBeGreaterThanOrEqual(5)
  })
})
