
import { spawn } from 'child_process'
import { join, dirname } from 'path'
import { access } from 'fs/promises'

// Convention: Bin/cstrike-online.exe directly under the install dir.
export async function findGameExecutable(installDir: string): Promise<string> {
  const exePath = join(installDir, 'Bin', 'cstrike-online.exe')
  await access(exePath)
  return exePath
}

export function launchWindows(exePath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      cwd: dirname(exePath),
      detached: true,
      stdio: 'ignore'
    })

    // Handle spawn errors so failed launches cannot crash the main process.
    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`Could not start the game: executable not found at ${exePath}`))
        return
      }
      reject(new Error(`Could not start the game: ${err.message}`))
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
