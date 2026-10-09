
import { promises as fs } from 'fs'
import { join } from 'path'

export interface InstalledFileEntry {
  path: string
  md5: string
}

export interface InstallState {
  version: string
  installDir: string
  files: InstalledFileEntry[]
}

const STATE_FILENAME = '.csore_install.json'

export function installStatePath(installDir: string): string {
  return join(installDir, STATE_FILENAME)
}

export async function readInstallState(installDir: string): Promise<InstallState | null> {
  try {
    const raw = await fs.readFile(installStatePath(installDir), 'utf-8')
    return JSON.parse(raw) as InstallState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeInstallState(installDir: string, state: InstallState): Promise<void> {
  await fs.writeFile(installStatePath(installDir), JSON.stringify(state, null, 2), 'utf-8')
}
