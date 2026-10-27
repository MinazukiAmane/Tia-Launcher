import { open } from 'node:fs/promises'

type Architecture = 'x86' | 'x64'
interface Layout {
  architecture: Architecture | null
  exportRva: number
  offset: (rva: number, length: number) => number
}
const flagName = Buffer.from('flags\0')
const pageSize = 64 * 1024
const maxRead = 4 * 1024 * 1024

function layout(coff: Buffer, rest: Buffer, fileSize: number): Layout | null {
  if (coff.length < 24 || coff.readUInt32LE(0) !== 0x4550) return null
  const machine = coff.readUInt16LE(4)
  const count = coff.readUInt16LE(6)
  const optionalSize = coff.readUInt16LE(20)
  if (optionalSize < 120 || rest.length < optionalSize + count * 40) return null
  const magic = rest.readUInt16LE(0)
  const directory = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1
  if (directory < 0 || directory + 8 > optionalSize) return null
  const exportRva = rest.readUInt32LE(directory)
  if (!exportRva) return null
  const architecture = machine === 0x14c && magic === 0x10b ? 'x86' : machine === 0x8664 && magic === 0x20b ? 'x64' : null
  return { architecture, exportRva, offset(rva, length) {
    for (let i = 0; i < count; i++) {
      const section = optionalSize + i * 40
      const start = rest.readUInt32LE(section + 12)
      const size = rest.readUInt32LE(section + 16)
      const raw = rest.readUInt32LE(section + 20)
      if (rva >= start && rva - start + length <= size && raw + rva - start + length <= fileSize) return raw + rva - start
    }
    throw new Error('Invalid client export table.')
  } }
}

export function exportedFlagArchitecture(data: Buffer): Architecture | null {
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) return null
  const pe = data.readUInt32LE(60)
  if (pe > data.length - 24) return null
  const info = layout(data.subarray(pe, pe + 24), data.subarray(pe + 24), data.length)
  if (!info) return null
  const exports = info.offset(info.exportRva, 40)
  const count = data.readUInt32LE(exports + 24)
  if (!count) return null
  const table = info.offset(data.readUInt32LE(exports + 32), count * 4)
  for (let i = 0; i < count; i++) {
    const name = info.offset(data.readUInt32LE(table + i * 4), 6)
    if (data.subarray(name, name + 6).equals(flagName)) {
      if (!info.architecture) throw new Error('Unsupported client architecture for exported flags.')
      return info.architecture
    }
  }
  return null
}

/** Read only PE headers/export pages, not multi-megabyte client code/overlays. */
export async function readFlagArchitecture(path: string): Promise<Architecture | null> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    const pages = new Map<number, Buffer>()
    const read = async (position: number, size: number): Promise<Buffer> => {
      if (size > maxRead || position < 0 || size < 0 || position + size > before.size) throw new Error('Invalid client export table.')
      const chunks: Buffer[] = []
      const end = position + size
      while (position < end) {
        const start = Math.floor(position / pageSize) * pageSize
        let page = pages.get(start)
        if (!page) {
          page = Buffer.allocUnsafe(Math.min(pageSize, before.size - start))
          let filled = 0
          while (filled < page.length) {
            const { bytesRead } = await file.read(page, filled, page.length - filled, start + filled)
            if (!bytesRead) throw new Error('Client executable changed during launch preparation.')
            filled += bytesRead
          }
          if (pages.size >= 8) pages.delete(pages.keys().next().value!)
          pages.set(start, page)
        }
        const take = Math.min(end - position, page.length - (position - start))
        chunks.push(page.subarray(position - start, position - start + take))
        position += take
      }
      return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)
    }
    if (!before.isFile() || before.size < 64) return null
    const dos = await read(0, 64)
    if (dos.readUInt16LE(0) !== 0x5a4d) return null
    const pe = dos.readUInt32LE(60)
    if (pe > before.size - 24) return null
    const coff = await read(pe, 24)
    if (coff.readUInt32LE(0) !== 0x4550) return null
    const restSize = coff.readUInt16LE(20) + coff.readUInt16LE(6) * 40
    const info = layout(coff, await read(pe + 24, restSize), before.size)
    if (!info) return null
    const exports = await read(info.offset(info.exportRva, 40), 40)
    const count = exports.readUInt32LE(24)
    if (!count) return null
    if (count * 4 > maxRead) throw new Error('Invalid client export table.')
    const table = await read(info.offset(exports.readUInt32LE(32), count * 4), count * 4)
    let architecture: Architecture | null = null
    for (let i = 0; i < count; i++) {
      if ((await read(info.offset(table.readUInt32LE(i * 4), 6), 6)).equals(flagName)) {
        if (!info.architecture) throw new Error('Unsupported client architecture for exported flags.')
        architecture = info.architecture
        break
      }
    }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev) throw new Error('Client executable changed during launch preparation.')
    return architecture
  } finally { await file.close() }
}
