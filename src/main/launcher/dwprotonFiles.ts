import { constants } from 'fs'
import { copyFile, lstat, readdir, rm } from 'fs/promises'
import { join } from 'path'

// User overrides belong to the user; binaries and bundled protonfixes belong to
// the new release. Wine prefixes and per-game launch settings live elsewhere.
const overrides = ['user_settings.py', 'dxvk.conf', 'vkd3d-proton.conf']
export async function copyDWProtonSettings(source: string, destination: string): Promise<void> {
  for (const name of overrides) {
    const file = join(source, name)
    try {
      if (!(await lstat(file)).isFile()) continue
      await copyFile(file, join(destination, name), constants.COPYFILE_EXCL)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      if (code === 'EEXIST' && (await lstat(join(destination, name))).isFile()) continue
      throw error
    }
  }
}

export async function retireDWProtonVersions(baseDir: string, currentTag: string): Promise<void> {
  if (!/^dwproton-\d[\w.-]*$/.test(currentTag)) throw new Error('Invalid DWProton release tag.')
  const root = join(baseDir, 'proton')
  const current = join(root, currentTag)
  if (!(await lstat(current)).isDirectory() || !(await lstat(join(current, 'proton'))).isFile()) throw new Error('New DWProton installation is incomplete.')
  const oldVersions = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name !== currentTag && /^dwproton-\d[\w.-]*$/.test(entry.name) && !entry.name.includes('.extracting-'))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  // Finish every settings transfer before deleting any old version. Existing
  // settings in the destination take precedence over an older override.
  for (const tag of oldVersions) await copyDWProtonSettings(join(root, tag), current)
  for (const tag of oldVersions) await rm(join(root, tag), { recursive: true, force: true })
}
