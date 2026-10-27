import { open } from 'node:fs/promises'

export type PEArchitecture = 'x86' | 'x64'

/** Generic PE architecture routing only. Client validation belongs to the runtime. */
export async function readPEArchitecture(path: string): Promise<PEArchitecture | null> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 64) return null
    const read = async (position: number, length: number): Promise<Buffer | null> => {
      if (position < 0 || position + length > before.size) return null
      const buffer = Buffer.allocUnsafe(length)
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled)
        if (!bytesRead) return null
        filled += bytesRead
      }
      return buffer
    }
    const dos = await read(0, 64)
    if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return null
    const pe = dos.readUInt32LE(60)
    const header = await read(pe, 26)
    if (!header || header.readUInt32LE(0) !== 0x4550 || header.readUInt16LE(20) < 2) return null
    const machine = header.readUInt16LE(4)
    const magic = header.readUInt16LE(24)
    const architecture = machine === 0x14c && magic === 0x10b ? 'x86'
      : machine === 0x8664 && magic === 0x20b ? 'x64' : null
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev) throw new Error('Client executable changed during launch preparation.')
    return architecture
  } finally { await file.close() }
}
