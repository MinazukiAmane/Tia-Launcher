import { activeGame } from './activeGame'
import { LAUNCHER_API_BASE_URL } from './catalog'
import { hasFreshGameCheckpoint } from './freshInstallCheckpoint'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { fetchLauncherInfo } from './launcherApi'
import { fetchVersionManifest } from './manifestVerify'
import { readInstallState, writeInstallState } from './installState'
import { resolveWithinRoot } from './pathSafety'

// Import only game folders selected through the native picker.
export async function importExistingInstall(installDir: string): Promise<boolean> {
  if (await readInstallState(installDir)) return false
  const entries = await readdir(installDir, { withFileTypes: true })
  if (hasFreshGameCheckpoint(installDir) || entries.some(entry => entry.name === '.csore_fresh_game.json')) return false
  const named = (name: string): boolean => entries.some(entry => entry.isDirectory() &&
    (process.platform === 'win32' ? entry.name.toLowerCase() === name.toLowerCase() : entry.name === name))
  if (activeGame().biz === 'csore_global') {
    if (!named('Bin')) return false
    let hasExecutable = false
    try { hasExecutable = (await stat(join(installDir, 'Bin', 'cstrike-online.exe'))).isFile() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!hasExecutable && !named('Data')) return false
  } else {
    try { if (!(await stat(join(installDir, activeGame().executable))).isFile()) return false } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const info = await fetchLauncherInfo(LAUNCHER_API_BASE_URL, activeGame().biz)
  const target = info.main.major
  const manifest = await fetchVersionManifest(target?.res_list_url)
  if (!target || !manifest?.repair_supported || manifest.version !== target.version || !manifest.files.length) {
    throw new Error('Existing game files detected, but the server repair manifest is not ready. Try again when it is available; your game files have been kept.')
  }
  for (const file of manifest.files) {
    if (!file.path || file.path.includes('\\') || file.path.includes(':') ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        !/^[a-f0-9]{32}$/i.test(file.md5) || !file.url || !/^https?:$/.test(new URL(file.url).protocol)) {
      throw new Error('The server repair manifest contains invalid file metadata.')
    }
    resolveWithinRoot(installDir, file.path, 'imported game file', reason => { throw new Error(reason) })
  }
  await writeInstallState(installDir, {
    version: target.version,
    installDir,
    needsRepair: true,
    files: manifest.files.map(({ path, md5 }) => ({ path, md5 }))
  })
  return true
}
