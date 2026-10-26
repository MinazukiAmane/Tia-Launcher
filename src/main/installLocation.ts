import { activeGame, gamePreferenceScope } from './activeGame'
import { GAMES } from './catalog'
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
  const selected = readRecord<{ installDir: string }>(gamePreferenceScope(), 'selectedInstallation')
  if (selected?.installDir && gameScope(selected.installDir) === gameScope(directory)) return true
  if (await readInstallState(directory) || hasFreshGameCheckpoint(directory)) return true
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.some(entry => entry.isDirectory() && entry.name === '.csore_download_tmp')
}

async function containsGame(directory: string): Promise<boolean> {
  if (activeGame().biz === 'csore_global') {
    const entries = await readdir(directory, { withFileTypes: true })
    if (['Bin', 'Data'].every(name => entries.some(entry => entry.isDirectory() && (process.platform === 'win32' ? entry.name.toLowerCase() === name.toLowerCase() : entry.name === name)))) return true
  }
  if (await isKnownInstallation(directory)) return true
  try { return (await stat(join(directory, activeGame().executable))).isFile() } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return false
}

export async function resolveInstallLocation(chosen: string): Promise<string> {
  const targetFolder = activeGame().installFolder
  for (const game of GAMES) {
    if (game.biz === activeGame().biz) continue
    const scope = game.biz === 'csore_global' ? 'launcher' : 'title:' + game.biz
    const selected = readRecord<{ installDir: string }>(scope, 'selectedInstallation')
    if (selected?.installDir && gameScope(selected.installDir) === gameScope(chosen)) throw new Error('This folder is registered for another game. Choose its parent folder.')
    try {
      if ((await stat(join(chosen, game.executable))).isFile()) throw new Error('This folder belongs to another game. Choose its parent folder so the games stay separate.')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const folder = basename(resolve(chosen))
  const legacyName = activeGame().biz === 'csore_global' && (process.platform === 'win32' ? folder.toLowerCase() === LEGACY_INSTALL_FOLDER.toLowerCase() : folder === LEGACY_INSTALL_FOLDER)
  // Only the legacy name and previously registered installs bypass the new subfolder.
  if (legacyName || await isKnownInstallation(chosen)) return chosen
  if (activeGame().biz === 'cedar_global') {
    try { if ((await stat(join(chosen, activeGame().executable))).isFile()) return chosen } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const alreadyNamed = process.platform === 'win32'
    ? basename(resolve(chosen)).toLowerCase() === targetFolder.toLowerCase()
    : basename(resolve(chosen)) === targetFolder
  const destination = alreadyNamed ? chosen : join(chosen, targetFolder)
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
