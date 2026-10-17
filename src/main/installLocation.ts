import { lstat, mkdir, readdir, stat } from 'fs/promises'
import { basename, join, parse, resolve, win32 } from 'path'
import { readInstallState } from './installState'
import { hasFreshGameCheckpoint } from './freshInstallCheckpoint'
import { gameScope, readRecord } from './localDatabase'

export const NEW_INSTALL_FOLDER = 'Tia-CSORSE'
export const LEGACY_INSTALL_FOLDER = 'Counter-Strike Online Re-Server Edition'

export function isFilesystemRoot(directory: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === 'win32' ? win32 : { resolve, parse }
  const path = paths.resolve(directory)
  return path === paths.parse(path).root
}

async function isKnownInstallation(directory: string): Promise<boolean> {
  const selected = readRecord<{ installDir: string }>('launcher', 'selectedInstallation')
  if (selected?.installDir && gameScope(selected.installDir) === gameScope(directory)) return true
  if (await readInstallState(directory) || hasFreshGameCheckpoint(directory)) return true
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.some(entry => entry.isDirectory() && entry.name === '.csore_download_tmp')
}

async function containsGame(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true })
  const named = (name: string): boolean => entries.some(entry => entry.isDirectory() &&
    (process.platform === 'win32' ? entry.name.toLowerCase() === name.toLowerCase() : entry.name === name))
  if (named('Bin') && named('Data')) return true
  if (await isKnownInstallation(directory)) return true
  if (named('Bin')) {
    try { return (await stat(join(directory, 'Bin', 'cstrike-online.exe'))).isFile() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return false
}

export async function resolveInstallLocation(chosen: string): Promise<string> {
  const folder = basename(resolve(chosen))
  const legacyName = process.platform === 'win32' ? folder.toLowerCase() === LEGACY_INSTALL_FOLDER.toLowerCase() : folder === LEGACY_INSTALL_FOLDER
  // Only the legacy name and previously registered installs bypass the new subfolder.
  if (legacyName || await isKnownInstallation(chosen)) return chosen
  const alreadyNamed = process.platform === 'win32'
    ? basename(resolve(chosen)).toLowerCase() === NEW_INSTALL_FOLDER.toLowerCase()
    : basename(resolve(chosen)) === NEW_INSTALL_FOLDER
  const destination = alreadyNamed ? chosen : join(chosen, NEW_INSTALL_FOLDER)
  try {
    const info = await lstat(destination)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`The installation folder is not a regular directory: ${destination}`)
    if (await containsGame(destination)) return destination
    if ((await readdir(destination)).length) throw new Error(`The folder "${destination}" contains unrelated files. Choose another location; its files have not been changed.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(destination)
  }
  return destination
}
