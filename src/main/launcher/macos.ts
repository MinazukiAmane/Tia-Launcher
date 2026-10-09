
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { access, readdir } from 'fs/promises'
import { homedir } from 'os'

const execFileAsync = promisify(execFile)

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

export async function launchMacOS(bottlePrefixPath: string, exePath: string, args: string[]): Promise<void> {
  try {
    await execFileAsync('wine', ['start', '/unix', exePath, ...args], {
      cwd: dirname(exePath),
      env: { ...process.env, WINEPREFIX: bottlePrefixPath }
    })
  } catch (err) {
    throw new Error(
      `Failed to launch via Whisky's Wine prefix (experimental, unofficial path): ${(err as Error).message}. Try opening the game manually via the Whisky app instead.`
    )
  }
}
