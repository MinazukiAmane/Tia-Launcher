import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import { importExistingInstall } from './existingInstall'
import { readInstallState, writeInstallState } from './installState'
import { performInstallOrUpdate, repairInstall, verifyInstall } from './gameManager'

let root: string
vi.mock('electron', () => ({ app: { getPath: () => root } }))
const assets = [
  { path: 'Bin/cstrike-online.exe', bytes: 'game fixture' },
  { path: 'Data/existing.dat', bytes: 'correct existing data' },
  { path: 'Data/missing.dat', bytes: 'missing data fixture' }
]

describe('importing game files from another launcher', () => {
  let dir: string
  let server: Server
  let manifest: { version: string; repair_supported: boolean; files: { path: string; md5: string; size: number; url: string }[] }
  let downloaded: string[]
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'csore-existing-'))
    dir = join(root, 'game')
    await mkdir(dir)
    downloaded = []
    server = createServer((req, res) => {
      const index = Number(req.url?.slice('/files/'.length))
      const asset = assets[index]
      if (!asset) { res.writeHead(404); res.end(); return }
      downloaded.push(asset.path)
      res.setHeader('Content-Length', Buffer.byteLength(asset.bytes))
      res.end(asset.bytes)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    manifest = {
      version: 'fixture-current', repair_supported: true,
      files: assets.map((asset, index) => ({
        path: asset.path, md5: createHash('md5').update(asset.bytes).digest('hex'),
        size: Buffer.byteLength(asset.bytes), url: `http://127.0.0.1:${address.port}/files/${index}`
      }))
    }
    const realFetch = global.fetch
    fetchMock = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options)
      return new Response(JSON.stringify(
      String(url).includes('launcher_info')
        ? { retcode: 0, data: { game_packages: [{ main: { major: { version: manifest.version, res_list_url: 'https://fixture.test/manifest' }, patches: [] } }] } }
        : manifest
    ))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  })

  async function writeGame(complete = true): Promise<void> {
    await mkdir(join(dir, 'Bin'))
    await mkdir(join(dir, 'Data'))
    for (const asset of complete ? assets : assets.slice(0, 2)) await writeFile(join(dir, asset.path), asset.bytes)
  }

  it('leaves an empty install folder ready for normal installation without network requests', async () => {
    expect(await importExistingInstall(dir)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await readInstallState(dir)).toBeNull()
  })

  it('keeps existing launcher metadata and version unchanged', async () => {
    const state = { version: 'older', installDir: dir, files: [] }
    await writeInstallState(dir, state)
    expect(await importExistingInstall(dir)).toBe(false)
    expect(await readInstallState(dir)).toEqual(state)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('imports matching game files, verifies them, and clears the repair requirement without downloading', async () => {
    await writeGame()
    expect(await importExistingInstall(dir)).toBe(true)
    expect((await readInstallState(dir))?.needsRepair).toBe(true)
    expect(await verifyInstall(dir, true)).toEqual({ ok: true, missingFiles: [], corruptFiles: [] })
    expect((await readInstallState(dir))?.needsRepair).toBe(false)
    expect(downloaded).toEqual([])
  })

  it('preserves valid assets and repairs only corrupt or missing files, never a full package', async () => {
    await writeGame(false)
    await writeFile(join(dir, assets[0].path), 'old game bytes')
    const before = await readFile(join(dir, assets[1].path))
    await importExistingInstall(dir)
    expect(await verifyInstall(dir)).toEqual({ ok: false, corruptFiles: [assets[0].path], missingFiles: [assets[2].path] })
    expect((await readInstallState(dir))?.needsRepair).toBe(true)
    await expect(performInstallOrUpdate(dir, () => {})).rejects.toThrow(/Verify or repair/)
    expect(await repairInstall(dir, () => {})).toEqual({ status: 'completed' })
    expect(downloaded).toEqual([assets[0].path, assets[2].path])
    expect(await readFile(join(dir, assets[1].path))).toEqual(before)
    expect((await readInstallState(dir))?.needsRepair).toBeUndefined()
    expect((await verifyInstall(dir)).ok).toBe(true)
  })

  it('does not classify a paused fresh installation as an imported game', async () => {
    await writeGame()
    await writeFile(join(dir, '.csore_fresh_game.json'), '{}')
    expect(await importExistingInstall(dir)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps game files untouched and writes no state when the manifest is unavailable', async () => {
    await writeGame()
    manifest.repair_supported = false
    await expect(importExistingInstall(dir)).rejects.toThrow(/manifest is not ready/)
    expect(await readInstallState(dir)).toBeNull()
    expect(await readFile(join(dir, assets[0].path), 'utf8')).toBe(assets[0].bytes)
  })

  it('rejects unsafe manifest paths before persisting metadata', async () => {
    await writeGame()
    manifest.files[0].path = '../outside.exe'
    await expect(importExistingInstall(dir)).rejects.toThrow(/invalid file metadata/)
    expect(await readInstallState(dir)).toBeNull()
  })

  it('can import a Bin and Data folder even when the game executable is missing', async () => {
    await mkdir(join(dir, 'Bin'))
    await mkdir(join(dir, 'Data'))
    expect(await importExistingInstall(dir)).toBe(true)
    expect((await verifyInstall(dir)).missingFiles).toEqual(assets.map(asset => asset.path))
  })
})
