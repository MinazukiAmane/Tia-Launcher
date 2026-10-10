
import { execFile, exec } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { access, readdir } from 'fs/promises'
import { homedir } from 'os'
import { buildWrappedCommand, quoteShellArgUnix } from './launchCommand'
import { logInfo, logDebug, logError } from '../logger'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

const WHISKY_BUNDLE_IDS = ['com.franke.Whisky', 'com.isaacmarovitz.Whisky']

export class WhiskyNotFoundError extends Error {
  constructor() {
    super('No Whisky bottle found. Install Whisky manually and create a bottle before playing on macOS.')
    this.name = 'WhiskyNotFoundError'
  }
}

export async function findWhiskyBottle(bottleName: string): Promise<string | null> {
  for (const bundleId of WHISKY_BUNDLE_IDS) {
    const bottlesDir = join(homedir(), 'Library', 'Containers', bundleId, 'Bottles')
    let entries: string[]
    try {
      entries = await readdir(bottlesDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const prefixPath = join(bottlesDir, entry)
      try {
        await access(join(prefixPath, 'drive_c'))

        void bottleName
        return prefixPath
      } catch {
        continue
      }
    }
  }
  return null
}

export async function launchMacOS(
  bottlePrefixPath: string,
  exePath: string,
  args: string[],
  launchCommand?: string | null
): Promise<void> {
  logInfo('launchMacOS: attempting launch', { exePath })
  const env = { ...process.env, WINEPREFIX: bottlePrefixPath }

  const realCommand = ['wine', 'start', '/unix', exePath, ...args].map(quoteShellArgUnix).join(' ')
  const wrapped = buildWrappedCommand(launchCommand, realCommand)
  if (wrapped) logDebug('launchMacOS: resolved launch command', { command: wrapped })

  try {
    if (wrapped === null) {
      await execFileAsync('wine', ['start', '/unix', exePath, ...args], { cwd: dirname(exePath), env })
    } else {
      // Launch Command wrappers require a shell.
      await execAsync(wrapped, { cwd: dirname(exePath), env })
    }
    logInfo('launchMacOS: succeeded', { exePath })
  } catch (err) {
    logError('launchMacOS: failed', { exePath, error: (err as Error).message })
    throw new Error(
      `Failed to launch via Whisky's Wine prefix (experimental, unofficial path): ${(err as Error).message}. Try opening the game manually via the Whisky app instead.`
    )
  }
}
