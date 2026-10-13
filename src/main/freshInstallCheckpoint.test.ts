import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { readFreshGameCheckpoint, writeFreshGameCheckpoint } from './freshInstallCheckpoint'
import type { VersionBlock } from './launcherApi'

const target: VersionBlock = {
  version: '1.0.0',
  game_pkgs: [{ url: 'https://fixture.test/game', md5: 'package-md5', size: '100', decompressed_size: '200' }],
  res_list_url: ''
}
const content = Buffer.from('extracted game data')
const files = [{ path: 'game.bin', md5: createHash('md5').update(content).digest('hex') }]
let dir: string
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('fresh game checkpoint', () => {
  it('reuses verified files even if download URLs change, but rejects a changed package or version', async () => {
    dir = await mkdtemp(join(tmpdir(), 'csore-checkpoint-'))
    await writeFile(join(dir, 'game.bin'), content)
    await writeFreshGameCheckpoint(dir, target, files)
    expect(await readFreshGameCheckpoint(dir, target)).toEqual(files)
    const newUrl = { ...target, game_pkgs: [{ ...target.game_pkgs[0], url: 'https://fixture.test/renewed' }] }
    expect(await readFreshGameCheckpoint(dir, newUrl)).toEqual(files)
    expect(await readFreshGameCheckpoint(dir, { ...target, version: '1.1.0' })).toBeNull()
    const newPackage = { ...target, game_pkgs: [{ ...target.game_pkgs[0], md5: 'new-package-md5' }] }
    expect(await readFreshGameCheckpoint(dir, newPackage)).toBeNull()
  })

  it('rejects missing/corrupt extracted files and interrupted checkpoint writes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'csore-checkpoint-'))
    await writeFreshGameCheckpoint(dir, target, files)
    expect(await readFreshGameCheckpoint(dir, target)).toBeNull()
    await writeFile(join(dir, 'game.bin'), content)
    expect(await readFreshGameCheckpoint(dir, target)).toEqual(files)
    await writeFile(join(dir, 'game.bin'), 'corrupt')
    expect(await readFreshGameCheckpoint(dir, target)).toBeNull()
    await writeFile(join(dir, '.csore_fresh_game.json'), '{')
    expect(await readFreshGameCheckpoint(dir, target)).toBeNull()
  })
})
