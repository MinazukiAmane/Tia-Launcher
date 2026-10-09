
import * as yauzl from 'yauzl'
import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import { pipeline } from 'stream/promises'
import { resolveWithinRoot } from './pathSafety'

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: true })
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
      await pipeline(readStream, writeStream)
    }
  } finally {
    zipfile.close()
  }
}
