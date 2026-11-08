import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAppImageContext, replaceAppImage } from '../../migration/electron/appImageMigration'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const unix = process.platform !== 'win32'
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tia-appimage-'))); directories.push(directory)
  const path = join(directory, 'My Tia Launcher.AppImage')
  const download = join(directory, 'download.AppImage')
  const payload = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2, 0]), Buffer.from('new launcher')])
  await writeFile(path, 'previous launcher', { mode: 0o751 })
  await chmod(path, 0o751)
  await writeFile(download, payload)
  return { directory, path, download, payload, hash: createHash('sha512').update(payload).digest('base64'), context: await readAppImageContext(path) }
}

it.skipIf(!unix)('replaces in place, preserves executable permissions, and leaves no staging files', async () => {
  const f = await fixture()
  await replaceAppImage(f.context, f.download, f.hash, async path => {
    expect(path).toBe(f.path)
    expect(await readFile(path)).toEqual(f.payload)
    expect((await stat(path)).mode & 0o777).toBe(0o751)
  })
  expect((await readdir(f.directory)).sort()).toEqual(['My Tia Launcher.AppImage', 'download.AppImage'])
})

it.skipIf(!unix)('restores the previous launcher if the new process cannot start', async () => {
  const f = await fixture()
  await expect(replaceAppImage(f.context, f.download, f.hash, async () => { throw new Error('spawn failed') })).rejects.toThrow('spawn failed')
  expect(await readFile(f.path, 'utf8')).toBe('previous launcher')
  expect((await readdir(f.directory)).some(name => name.startsWith('.tia-update-'))).toBe(false)
})

it.skipIf(!unix)('rejects changed downloads and signed payloads in the wrong format before replacing anything', async () => {
  const f = await fixture()
  await writeFile(f.download, 'not an AppImage')
  await expect(replaceAppImage(f.context, f.download, f.hash, async () => {})).rejects.toThrow(/changed/)
  const hash = createHash('sha512').update('not an AppImage').digest('base64')
  await expect(replaceAppImage(f.context, f.download, hash, async () => {})).rejects.toThrow(/not a supported AppImage/)
  expect(await readFile(f.path, 'utf8')).toBe('previous launcher')
})

it.skipIf(!unix)('rejects symlink installs, package-managed installs and externally replaced launchers', async () => {
  const f = await fixture()
  const alias = join(f.directory, 'alias.AppImage'); await symlink(f.path, alias)
  await expect(readAppImageContext(alias)).rejects.toThrow(/could not be verified/)
  await expect(readAppImageContext(undefined)).rejects.toThrow(/package manager/)
  const replacement = join(f.directory, 'other'); await writeFile(replacement, 'external update', { mode: 0o751 }); await rename(replacement, f.path)
  await expect(replaceAppImage(f.context, f.download, f.hash, async () => {})).rejects.toThrow(/installation changed/)
  expect(await readFile(f.path, 'utf8')).toBe('external update')
})
