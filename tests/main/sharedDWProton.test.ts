import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { selectGame } from '../../src/main/activeGame'
import { getDWProtonStatus, launchGame } from '../../src/main/gameManager'
import { fetchLatestDWProtonRelease, launchLinux } from '../../src/main/launcher/linux'
let root: string
vi.mock('electron', () => ({ app: { getPath: () => root } }))
vi.mock('../../src/main/launcher/linux', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/main/launcher/linux')>(),
  fetchLatestDWProtonRelease: vi.fn().mockResolvedValue({tagName:'dwproton-11.0-15',downloadUrl:'https://fixture.test/runtime.tar.xz',sha512sumUrl:'https://fixture.test/runtime.sha512sum'}),
  launchLinux: vi.fn().mockResolvedValue(undefined)
}))
beforeEach(async () => {
  selectGame('csore_global');vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected archive download')))
  root = await mkdtemp(join(tmpdir(), 'tia-shared-proton-'))
  for (const exe of ['cso/Bin/cstrike-online.exe', 'silver/SilverPalace/Binaries/Win64/SilverPalaceClient-Win64-Shipping.exe']) {
    await mkdir(join(root, exe, '..'), { recursive: true });await writeFile(join(root, exe), 'fixture')
  }
})
afterEach(async () => { selectGame('csore_global');vi.unstubAllGlobals();await rm(root, { recursive: true, force: true }) })
async function runtime(tag: string): Promise<string> {
  const dir=join(root,'runtimes/proton',tag);await mkdir(dir,{recursive:true});await writeFile(join(dir,'proton'),'fixture');return dir
}
it.runIf(process.platform === 'linux')('reuses Tia runtime for both titles without downloading its archive, with separate game prefixes', async () => {
  await runtime('dwproton-11.0-14')
  const dir=await runtime('dwproton-11.0-15')
  await launchGame(join(root,'cso'))
  selectGame('cedar_global')
  await launchGame(join(root,'silver'))
  expect(fetchLatestDWProtonRelease).toHaveBeenCalledTimes(2)
  expect(global.fetch).not.toHaveBeenCalled()
  const calls=vi.mocked(launchLinux).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[0][0]).toBe(dir);expect(calls[1][0]).toBe(dir)
  expect(calls[0][1]).toBe(join(root,'runtimes/prefix'))
  expect(calls[1][1]).toBe(join(root,'runtimes/prefix-cedar_global'))
})
it('recognizes an existing runtime without a download', async () => {
  await runtime('dwproton-11.0-15')
  await mkdir(join(root,'runtimes/proton/dwproton-11.0-20'),{recursive:true})
  expect(await getDWProtonStatus()).toEqual({ installed:true, version:'dwproton-11.0-15' })
})
it.runIf(process.platform === 'linux')('requests a download only when there is no usable installed runtime', async () => {
  vi.mocked(fetchLatestDWProtonRelease).mockRejectedValueOnce(new Error('network unavailable'))
  await mkdir(join(root,'runtimes/proton/dwproton-11.0-20'),{recursive:true})
  await expect(launchGame(join(root,'cso'))).rejects.toThrow('network unavailable')
  expect(fetchLatestDWProtonRelease).toHaveBeenCalledTimes(1)
  expect(launchLinux).not.toHaveBeenCalled()
})
