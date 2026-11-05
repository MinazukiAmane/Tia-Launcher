
import * as yauzl from 'yauzl'
import { createWriteStream } from 'fs'
import { mkdir, mkdtemp, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import { createHash } from 'crypto'
import { resolveWithinRoot, assertNoLinkedPath } from './pathSafety'
import { retryTransientFileAccess } from './fileAccess'
import type { InstalledFileEntry } from './installState'

export async function extractZip(
  zipPath: string,
  destDir: string,
  // Optional (entriesDone, entryCount) callback, throttled to ~4/s and
  // always fired for the final entry.
  onProgress?: (entriesDone: number, entryCount: number) => void
): Promise<InstalledFileEntry[]> {
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: true })
  const files: InstalledFileEntry[] = []
  const entryCount = zipfile.entryCount
  let entriesDone = 0
  let lastEmit = 0
  const tick = (): void => {
    entriesDone++
    if (!onProgress) return
    const now = Date.now()
    if (entriesDone === entryCount || now - lastEmit >= 250) {
      lastEmit = now
      onProgress(entriesDone, entryCount)
    }
  }
  try {
    for await (const entry of zipfile.eachEntry()) {
      const isDirEntry = entry.fileName.endsWith('/') || entry.fileName.endsWith('\\')

      const destPath = resolveWithinRoot(destDir, entry.fileName, 'zip entry', (reason) => {
        throw new Error(`refusing to extract unsafe zip entry: ${reason}`)
      })

      await assertNoLinkedPath(destDir, destPath)
      const unixType = (entry.externalFileAttributes >>> 16) & 0xf000
      if (unixType && unixType !== 0x8000 && unixType !== 0x4000) throw new Error('Archive contains an unsupported special file.')
      if (isDirEntry) {
        await mkdir(destPath, { recursive: true })
        tick()
        continue
      }

      await mkdir(dirname(destPath), { recursive: true })
      const readStream = await zipfile.openReadStreamPromise(entry)
      const temporaryDir = await mkdtemp(join(dirname(destPath), '.tia-extract-'))
      const temporaryPath = join(temporaryDir, 'content')
      const writeStream = createWriteStream(temporaryPath, { flags: 'wx' })

      const hash = createHash('md5')
      const hashingPassThrough = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        }
      })

      try {
        await pipeline(readStream, hashingPassThrough, writeStream)
        await assertNoLinkedPath(destDir, destPath)
        await retryTransientFileAccess(() => rename(temporaryPath, destPath))
      } finally { await rm(temporaryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }

      files.push({
        path: entry.fileName.replace(/\\/g, '/'),
        md5: hash.digest('hex')
      })
      tick()
    }
  } finally {
    zipfile.close()
  }
  return files
}
