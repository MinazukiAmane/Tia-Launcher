import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, access, symlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { retireDWProtonVersions } from '../../../src/main/launcher/dwprotonFiles'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tia-runtime-migration-')); roots.push(root)
  const old = join(root, 'proton/dwproton-11.0-14'), current = join(root, 'proton/dwproton-11.0-15')
  for (const path of [old, current]) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'proton'), 'engine') }
  return { root, old, current }
}
it('transfers custom overrides, keeps newer settings and leaves both game prefixes untouched', async () => {
  const { root, old, current } = await fixture()
  await writeFile(join(old, 'user_settings.py'), '# user settings')
  await writeFile(join(old, 'dxvk.conf'), 'old config')
  await writeFile(join(current, 'dxvk.conf'), 'newer user config')
  await mkdir(join(old, 'protonfixes')); await writeFile(join(old, 'protonfixes/old.py'), 'obsolete bundled code')
  for (const prefix of ['prefix', 'prefix-cedar_global']) {
    await mkdir(join(root, prefix)); await writeFile(join(root, prefix, 'user.reg'), 'saved prefix')
  }
  await retireDWProtonVersions(root, 'dwproton-11.0-15')
  expect(await readFile(join(current, 'user_settings.py'), 'utf8')).toBe('# user settings')
  expect(await readFile(join(current, 'dxvk.conf'), 'utf8')).toBe('newer user config')
  await expect(access(old)).rejects.toThrow()
  await expect(access(join(current, 'protonfixes/old.py'))).rejects.toThrow()
  for (const prefix of ['prefix', 'prefix-cedar_global']) expect(await readFile(join(root, prefix, 'user.reg'), 'utf8')).toBe('saved prefix')
})
it('does not remove the working version when the replacement is incomplete', async () => {
  const { root, old, current } = await fixture()
  await rm(join(current, 'proton'))
  await expect(retireDWProtonVersions(root, 'dwproton-11.0-15')).rejects.toThrow()
  await expect(access(join(old, 'proton'))).resolves.toBeUndefined()
})
it.skipIf(process.platform === 'win32')('does not follow version-directory symlinks or touch unrelated directories', async () => {
  const { root } = await fixture()
  const other = await mkdtemp(join(tmpdir(), 'tia-unrelated-runtime-')); roots.push(other)
  await writeFile(join(other, 'keep'), 'unrelated')
  await symlink(other, join(root, 'proton/dwproton-11.0-13'))
  await mkdir(join(root, 'proton/custom-runtime'))
  await retireDWProtonVersions(root, 'dwproton-11.0-15')
  expect(await readFile(join(other, 'keep'), 'utf8')).toBe('unrelated')
  await expect(access(join(root, 'proton/custom-runtime'))).resolves.toBeUndefined()
})

it('keeps old configuration when a destination conflict prevents its transfer', async () => {
  const { root, old, current } = await fixture()
  await writeFile(join(old, 'user_settings.py'), '# retain me')
  await mkdir(join(current, 'user_settings.py'))
  await expect(retireDWProtonVersions(root, 'dwproton-11.0-15')).rejects.toThrow()
  expect(await readFile(join(old, 'user_settings.py'), 'utf8')).toBe('# retain me')
})
