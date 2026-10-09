
import * as yauzl from 'yauzl'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import { createHash } from 'crypto'
import { resolveWithinRoot } from './pathSafety'
import type { InstalledFileEntry } from './installState'

export async function extractZip(zipPath: string, destDir: string): Promise<InstalledFileEntry[]> {
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: true })
  const files: InstalledFileEntry[] = []
  try {
    for await (const entry of zipfile.eachEntry()) {
      const isDirEntry = entry.fileName.endsWith('/') || entry.fileName.endsWith('\\')

      const destPath = resolveWithinRoot(destDir, entry.fileName, 'zip entry', (reason) => {
        throw new Error(`refusing to extract unsafe zip entry: ${reason}`)
      })

      if (isDirEntry) {
        await mkdir(destPath, { recursive: true })
        continue
      }

      await mkdir(dirname(destPath), { recursive: true })
      const readStream = await zipfile.openReadStreamPromise(entry)
      const writeStream = createWriteStream(destPath)

      const hash = createHash('md5')
      const hashingPassThrough = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        }
      })

      await pipeline(readStream, hashingPassThrough, writeStream)

      files.push({
        path: entry.fileName.replace(/\\/g, '/'),
        md5: hash.digest('hex')
      })
    }
  } finally {
    zipfile.close()
  }
  return files
}
