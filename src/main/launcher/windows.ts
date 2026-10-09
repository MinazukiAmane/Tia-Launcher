
import { spawn } from 'child_process'
import { join } from 'path'
import { access } from 'fs/promises'

// Convention: Bin/CSORE.exe directly under the install dir.
export async function findGameExecutable(installDir: string): Promise<string> {
  const exePath = join(installDir, 'Bin', 'CSORE.exe')
  await access(exePath)
  return exePath
}

export function launchWindows(exePath: string, args: string[]): void {
  const child = spawn(exePath, args, { detached: true, stdio: 'ignore' })
  child.unref()
}
