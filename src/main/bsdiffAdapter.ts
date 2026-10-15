
import { mkdtemp, rm, readFile, writeFile, open } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logError } from './logger'

import { retryTransientFileAccess } from './fileAccess'

const bufferPatch = async (oldFile: Buffer, delta: Buffer): Promise<Buffer> => {
  const dir = await mkdtemp(join(tmpdir(), 'csore-bspatch-'))
  try {
    const oldPath = join(dir, 'old.bin')
    const deltaPath = join(dir, 'delta.bsdiff')
    const newPath = join(dir, 'new.bin')

    await writeFile(oldPath, oldFile)
    await writeFile(deltaPath, delta)

    // Load the native binding only when a delta actually needs applying.
    const { patch } = await import('@bsdiff-rust/node')
    await patch(oldPath, newPath, deltaPath)

    return await retryTransientFileAccess(() => readFile(newPath))
  } finally {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
    catch (error) { logError('bspatch: temporary file cleanup deferred', { dir, code: (error as NodeJS.ErrnoException).code }) }
  }
}

// Patch files directly to avoid duplicate buffers and temporary files.
async function filePatch(oldPath: string, newPath: string, deltaPath: string): Promise<void> {
  const { patch } = await import('@bsdiff-rust/node')
  await patch(oldPath, newPath, deltaPath)
  await retryTransientFileAccess(async () => {
    const handle = await open(newPath, 'r')
    await handle.close()
  })
}
export const bspatch = Object.assign(bufferPatch, { files: filePatch })
