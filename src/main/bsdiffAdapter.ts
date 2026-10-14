
import { patch } from '@bsdiff-rust/node'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { logError } from './logger'

async function readPatchOutput(path: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try { return await readFile(path) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || (process.platform === 'win32' && code === 'UNKNOWN')
      if (!transient || attempt >= 8) throw error
      // Windows scanners can briefly hold a newly generated executable.
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

export async function bspatch(oldFile: Buffer, delta: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-bspatch-'))
  try {
    const oldPath = join(dir, 'old.bin')
    const deltaPath = join(dir, 'delta.bsdiff')
    const newPath = join(dir, 'new.bin')

    await writeFile(oldPath, oldFile)
    await writeFile(deltaPath, delta)

    await patch(oldPath, newPath, deltaPath)

    return await readPatchOutput(newPath)
  } finally {
    try { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
    catch (error) { logError('bspatch: temporary file cleanup deferred', { dir, code: (error as NodeJS.ErrnoException).code }) }
  }
}
