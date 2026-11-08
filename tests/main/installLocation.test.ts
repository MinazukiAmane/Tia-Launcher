import { moveInstallDirectory } from '../../src/main/moveInstallation'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, parse } from 'path'
import { NEW_INSTALL_FOLDER, isFilesystemRoot, resolveInstallLocation } from '../../src/main/installLocation'
import { writeInstallState } from '../../src/main/installState'
import { writeFreshGameCheckpoint } from '../../src/main/freshInstallCheckpoint'
import { uninstallGame } from '../../src/main/gameManager'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tia-location-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function game(directory: string): Promise<void> {
  await mkdir(join(directory, 'Bin'), { recursive: true })
  await mkdir(join(directory, 'Data'))
  await writeFile(join(directory, 'Data', 'existing.dat'), 'keep existing game')
}

describe('game installation folder selection', () => {
  it('creates Tia-CSORSE below a selected parent and leaves unrelated files intact', async () => {
    await writeFile(join(root, 'personal.txt'), 'keep personal files')
    const selected = await resolveInstallLocation(root)
    expect(selected).toBe(join(root, NEW_INSTALL_FOLDER))
    expect(await readdir(selected)).toEqual([])
    expect(await readFile(join(root, 'personal.txt'), 'utf8')).toBe('keep personal files')
  })

  it('uses the explicitly named legacy folder directly', async () => {
    const name = 'Counter-Strike Online Re-Server Edition'
    const directory = join(root, name)
    await game(directory)
    expect(await resolveInstallLocation(directory)).toBe(directory)
    expect(await readFile(join(directory, 'Data', 'existing.dat'), 'utf8')).toBe('keep existing game')
    expect(await readdir(directory)).not.toContain(NEW_INSTALL_FOLDER)
  })

  it.each(['CSORE', 'My Existing Game'])('keeps a previously registered %s installation', async name => {
    const directory = join(root, name)
    await game(directory)
    await writeInstallState(directory, { version: 'installed', installDir: directory, files: [] })
    expect(await resolveInstallLocation(directory)).toBe(directory)
    expect(await readdir(directory)).not.toContain(NEW_INSTALL_FOLDER)
  })

  it('does not treat generic Bin and Data folders as a legacy-folder exception', async () => {
    const directory = join(root, 'unregistered folder')
    await game(directory)
    expect(await resolveInstallLocation(directory)).toBe(join(directory, NEW_INSTALL_FOLDER))
    expect(await readFile(join(directory, 'Data', 'existing.dat'), 'utf8')).toBe('keep existing game')
  })

  it('reuses the Tia-CSORSE child when the selected parent already contains it', async () => {
    const directory = join(root, NEW_INSTALL_FOLDER)
    await game(directory)
    expect(await resolveInstallLocation(root)).toBe(directory)
  })

  it('does not nest another Tia-CSORSE when its empty folder is selected directly', async () => {
    const directory = join(root, NEW_INSTALL_FOLDER)
    await mkdir(directory)
    expect(await resolveInstallLocation(directory)).toBe(directory)
    expect(await readdir(directory)).toEqual([])
  })

  it('preserves a previously selected installation even if its game files need repair', async () => {
    const directory = join(root, 'custom installation')
    await mkdir(directory)
    await writeInstallState(directory, { version: 'installed', installDir: directory, files: [{ path: 'Bin/client.exe', md5: 'missing-file-hash' }] })
    expect(await resolveInstallLocation(directory)).toBe(directory)
  })

  it('keeps an interrupted download or extraction in its current directory', async () => {
    const download = join(root, 'my partial download')
    await mkdir(join(download, '.csore_download_tmp'), { recursive: true })
    expect(await resolveInstallLocation(download)).toBe(download)
    const extracted = join(root, 'my extracted game')
    await mkdir(extracted)
    await writeFreshGameCheckpoint(extracted, { version: 'pending', game_pkgs: [], res_list_url: '' }, [])
    expect(await resolveInstallLocation(extracted)).toBe(extracted)
  })

  it('rejects a destination containing unrelated files without modifying them', async () => {
    const directory = join(root, NEW_INSTALL_FOLDER)
    await mkdir(directory)
    await writeFile(join(directory, 'important.txt'), 'keep this')
    await expect(resolveInstallLocation(root)).rejects.toThrow(/unrelated files/)
    expect(await readFile(join(directory, 'important.txt'), 'utf8')).toBe('keep this')
  })

  it('rejects a child symlink to another folder', async () => {
    const other = join(root, 'unrelated')
    await mkdir(other)
    await writeFile(join(other, 'important.txt'), 'keep this')
    await symlink(other, join(root, NEW_INSTALL_FOLDER), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveInstallLocation(root)).rejects.toThrow(/not a regular directory/)
    expect(await readFile(join(other, 'important.txt'), 'utf8')).toBe('keep this')
  })
})

it('recognizes Windows drive/share roots and refuses to recursively uninstall a filesystem root', async () => {
  for (const path of ['C:\\', 'D:\\', '\\\\server\\share\\']) expect(isFilesystemRoot(path, 'win32')).toBe(true)
  expect(isFilesystemRoot('D:\\Tia-CSORSE', 'win32')).toBe(false)
  await expect(uninstallGame(parse(root).root)).rejects.toThrow(/entire drive/)
  await expect(moveInstallDirectory(parse(root).root, join(root, 'destination'))).rejects.toThrow(/entire drive/)
})
