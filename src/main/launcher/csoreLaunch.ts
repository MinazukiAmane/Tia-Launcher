import { app } from 'electron'
import { logInfo, logError } from '../logger'
import { readFile, mkdtemp, rm, access, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { readPEArchitecture } from './peArchitecture'

export interface LaunchSession {
  executable: string
  args: string[]
  ready: () => Promise<void>
  cleanup: () => Promise<void>
}
const architectureCache = new Map<string, { stamp: string; architecture: 'x86' | 'x64' | null }>()

export async function prepareCSORELaunch(exePath: string, args: string[]): Promise<LaunchSession> {
  const started = performance.now()
  let architecture: 'x86' | 'x64' | null = null
  try {
    const info = await stat(exePath)
    const stamp = JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.ino, info.dev])
    const cached = architectureCache.get(exePath)
    architecture = cached?.stamp === stamp ? cached.architecture : await readPEArchitecture(exePath)
    architectureCache.set(exePath, { stamp, architecture })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Game executable not found at ${exePath}.`)
    throw error
  }
  if (!architecture) {
    logError('csoreLaunch: unsupported executable architecture', { exePath })
    throw new Error('Could not initialize game launch.')
  }
  logInfo('csoreLaunch: architecture inspection completed', { durationMs: Math.round(performance.now() - started) })
  const executable = join(app.isPackaged ? join(process.resourcesPath, 'client-runtime') : join(process.cwd(), 'build', 'native'), `csore-start-${architecture}.exe`)
  await access(executable)
  const staging = await mkdtemp(join(tmpdir(), 'tia-client-'))
  const report = join(staging, 'status.txt')
  const winePath = (path: string): string => process.platform === 'win32' ? path : 'Z:' + path.replace(/\//g, '\\')
  return {
    executable, args: [winePath(report), winePath(exePath), ...args],
    ready: async () => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        let status = ''
        try { status = await readFile(report, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (status.startsWith('ready\n')) { logInfo('csoreLaunch: client initialized', { report, durationMs: Math.round(performance.now() - started) }); return }
        if (status.startsWith('error:')) throw new Error(status.trim())
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('Timed out waiting for client startup. The client was not confirmed ready.')
    },
    cleanup: async () => {
      // Windows can still hold the report open after its first ready line.
      try { await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
      catch (error) { logError('csoreLaunch: temporary report cleanup deferred', { report, code: (error as NodeJS.ErrnoException).code }) }
    }
  }
}
