
import { spawn } from 'child_process'
import { join, dirname } from 'path'
import { access } from 'fs/promises'
import { buildWrappedCommand, quoteShellArgWindows } from './launchCommand'
import { logInfo, logDebug, logError } from '../logger'

// Convention: Bin/cstrike-online.exe directly under the install dir.
export async function findGameExecutable(installDir: string): Promise<string> {
  const exePath = join(installDir, 'Bin', 'cstrike-online.exe')
  await access(exePath)
  return exePath
}

// Optional shell wrapper supporting the %command% placeholder.
export function launchWindows(exePath: string, args: string[], launchCommand?: string | null): Promise<void> {
  logInfo('launchWindows: attempting launch', { exePath })
  const realCommand = [exePath, ...args].map(quoteShellArgWindows).join(' ')
  const wrapped = buildWrappedCommand(launchCommand, realCommand)
  if (wrapped) logDebug('launchWindows: resolved launch command', { command: wrapped })

  return new Promise((resolve, reject) => {
    const child =
      wrapped === null
        ? spawn(exePath, args, {
            cwd: dirname(exePath),
            detached: true,
            stdio: 'ignore'
          })
        : spawn(wrapped, {
            cwd: dirname(exePath),
            detached: true,
            stdio: 'ignore',

            shell: true
          })

    // Handle spawn errors so failed launches cannot crash the main process.
    child.once('error', (err: NodeJS.ErrnoException) => {
      const launchErr =
        wrapped === null && err.code === 'ENOENT'
          ? new Error(`Could not start the game: executable not found at ${exePath}`)
          : new Error(`Could not start the game: ${err.message}`)
      logError('launchWindows: failed', { exePath, error: launchErr.message })
      reject(launchErr)
    })
    child.once('spawn', () => {
      child.unref()
      logInfo('launchWindows: succeeded', { exePath })
      resolve()
    })
  })
}
