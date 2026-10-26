import { app } from 'electron'
import { access, mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { FlagLaunch } from './flagLaunch'

// Native implementation is built from the private helper repository. This
// public boundary contains only its launch/report protocol, never game patches.
export async function prepareNativeGameLaunch(exePath: string, args: string[]): Promise<FlagLaunch> {
  await access(exePath)
  const root = app.isPackaged ? join(process.resourcesPath, 'game-runtime') : join(process.cwd(), 'build/native/cedar')
  const executable = join(root, 'cedar-start-x64.exe')
  await access(executable)
  await access(join(root, 'cedar-client-x64.dll'))
  const staging = await mkdtemp(join(tmpdir(), 'tia-game-'))
  const report = join(staging, 'status.txt')
  const windowsPath = (value: string): string => process.platform === 'win32' ? value : 'Z:' + value.replace(/\//g, '\\')
  return {
    executable, args: [windowsPath(report), windowsPath(exePath), ...args],
    ready: async () => {
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline) {
        let status = ''
        try { status = await readFile(report, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (status.startsWith('ready\n')) return
        if (status.startsWith('error:')) throw new Error(status.trim())
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('The game did not confirm startup. Check its startup log and try again.')
    },
    cleanup: () => rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
