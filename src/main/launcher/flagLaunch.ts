import { app } from 'electron'
import { logInfo, logError } from '../logger'
import { readFile, mkdtemp, rm, access, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// A flags export is required for every client launch. Inspect exports, never a hardcoded RVA.
export function exportedFlagArchitecture(data: Buffer): 'x86' | 'x64' | null {
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) return null
  const pe = data.readUInt32LE(60)
  if (pe > data.length - 24 || data.readUInt32LE(pe) !== 0x4550) return null
  const machine = data.readUInt16LE(pe + 4)
  const optionalSize = data.readUInt16LE(pe + 20)
  const optional = pe + 24
  const sectionsStart = optional + optionalSize
  const count = data.readUInt16LE(pe + 6)
  if (sectionsStart + count * 40 > data.length || optionalSize < 120) return null
  const magic = data.readUInt16LE(optional)
  const directory = optional + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0)
  if (directory === optional || directory + 8 > sectionsStart) return null
  const exportRva = data.readUInt32LE(directory)
  if (!exportRva) return null
  function offset(rva: number, length: number): number {
    for (let i = 0; i < count; i++) {
      const section = sectionsStart + i * 40
      const start = data.readUInt32LE(section + 12)
      const size = data.readUInt32LE(section + 16)
      const raw = data.readUInt32LE(section + 20)
      if (rva >= start && rva - start + length <= size && raw + rva - start + length <= data.length) return raw + rva - start
    }
    throw new Error('Invalid client export table.')
  }
  const exports = offset(exportRva, 40)
  const names = data.readUInt32LE(exports + 24)
  if (!names) return null
  const table = offset(data.readUInt32LE(exports + 32), names * 4)
  for (let i = 0; i < names; i++) {
    const name = offset(data.readUInt32LE(table + i * 4), 6)
    if (data.subarray(name, name + 6).equals(Buffer.from('flags\0'))) {
      if (machine === 0x14c && magic === 0x10b) return 'x86'
      if (machine === 0x8664 && magic === 0x20b) return 'x64'
      throw new Error('Unsupported client architecture for exported flags.')
    }
  }
  return null
}

export interface FlagLaunch {
  executable: string
  args: string[]
  ready: () => Promise<void>
  cleanup: () => Promise<void>
}
const exportCache = new Map<string, { stamp: string; architecture: 'x86' | 'x64' | null }>()

export async function prepareFlagLaunch(exePath: string, args: string[]): Promise<FlagLaunch> {
  let architecture: ReturnType<typeof exportedFlagArchitecture> = null
  try {
    const info = await stat(exePath)
    const stamp = JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.ino, info.dev])
    const cached = exportCache.get(exePath)
    architecture = cached?.stamp === stamp ? cached.architecture : exportedFlagArchitecture(await readFile(exePath))
    exportCache.set(exePath, { stamp, architecture })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Game executable not found at ${exePath}.`)
    throw error
  }
  if (!architecture) {
    logError('flagLaunch: required flags export missing', { exePath })
    throw new Error('Could not initialize game launch.')
  }
  const executable = join(app.isPackaged ? join(process.resourcesPath, 'flag-launch') : join(process.cwd(), 'build', 'native'), `flag-launch-${architecture}.exe`)
  await access(executable)
  const staging = await mkdtemp(join(tmpdir(), 'csore-flags-'))
  const report = join(staging, 'status.txt')
  const winePath = (path: string): string => process.platform === 'win32' ? path : 'Z:' + path.replace(/\//g, '\\')
  return {
    executable, args: [winePath(report), winePath(exePath), ...args],
    ready: async () => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        let status = ''
        try { status = await readFile(report, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (status.startsWith('ready\n')) { logInfo('flagLaunch: client initialized', { status: status.trim(), report }); return }
        if (status.startsWith('error:')) throw new Error(status.trim())
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('Timed out waiting for client flags initialization. The client was not confirmed ready.')
    },
    cleanup: async () => {
      // Windows can still hold the report open after its first ready line.
      try { await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
      catch (error) { logError('flagLaunch: temporary report cleanup deferred', { report, code: (error as NodeJS.ErrnoException).code }) }
    }
  }
}
