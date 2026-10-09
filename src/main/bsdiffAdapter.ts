
import { patch } from '@bsdiff-rust/node'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export async function bspatch(oldFile: Buffer, delta: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-bspatch-'))
  try {
    const oldPath = join(dir, 'old.bin')
    const deltaPath = join(dir, 'delta.bsdiff')
    const newPath = join(dir, 'new.bin')

    await writeFile(oldPath, oldFile)
    await writeFile(deltaPath, delta)

    await patch(oldPath, newPath, deltaPath)

    return await readFile(newPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
