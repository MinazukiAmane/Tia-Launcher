
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { decideAction, reassembleParts } from './installManager'
import type { GamePackageEntry, PkgEntry } from './launcherApi'
import type { InstallState } from './installState'

function makeInfo(majorVersion: string, patches: Array<{ version: string }> = []): GamePackageEntry {
  return {
    game: { id: 'g', biz: 'csore_global' },
    main: {
      major: { version: majorVersion, game_pkgs: [], res_list_url: '' },
      patches: patches.map((p) => ({ version: p.version, game_pkgs: [], res_list_url: '' })),
      required_client_version: ''
    }
  }
}

describe('decideAction', () => {
  it('returns fresh_install when there is no existing state', () => {
    const action = decideAction(makeInfo('0.1.51'), null)
    expect(action).toEqual({ kind: 'fresh_install', target: { version: '0.1.51', game_pkgs: [], res_list_url: '' } })
  })

  it('returns up_to_date when the installed version matches main.major', () => {
    const state: InstallState = { version: '0.1.51', installDir: '/x', files: [] }
    const action = decideAction(makeInfo('0.1.51'), state)
    expect(action).toEqual({ kind: 'up_to_date' })
  })

  it('returns apply_patch when a patch matches the installed version', () => {
    const state: InstallState = { version: '0.0.51', installDir: '/x', files: [] }
    const action = decideAction(makeInfo('0.1.51', [{ version: '0.0.51' }]), state)
    expect(action.kind).toBe('apply_patch')
    if (action.kind === 'apply_patch') {
      expect(action.patch.version).toBe('0.0.51')
      expect(action.toVersion).toBe('0.1.51')
    }
  })

  it('falls back to fresh_install when no patch matches (gap too large)', () => {
    const state: InstallState = { version: '0.0.1', installDir: '/x', files: [] }
    const action = decideAction(makeInfo('0.1.51', [{ version: '0.0.51' }]), state)
    expect(action.kind).toBe('fresh_install')
  })

  it('throws when the backend publishes no major version at all', () => {
    const info = makeInfo('0.1.51')
    info.main.major = null
    expect(() => decideAction(info, null)).toThrow()
  })

  it('returns fresh_install (not a crash) when state exists but installDir/files are stale and version has no matching patch', () => {

    const state: InstallState = { version: '0.0.1', installDir: '/does/not/exist', files: [{ path: 'a', md5: 'x' }] }
    const action = decideAction(makeInfo('0.1.51', [{ version: '0.0.51' }]), state)
    expect(action.kind).toBe('fresh_install')
  })
})

describe('reassembleParts', () => {
  let server: Server
  let baseUrl: string
  let tempDirs: string[] = []

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'csore-reassemble-test-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(async () => {
    server?.close()
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
    tempDirs = []
  })

  it('downloads every part and concatenates them in array order, not completion order', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    const chunkA = Buffer.from('AAAA')
    const chunkB = Buffer.from('BBBBBB')
    const byUrl: Record<string, Buffer> = { '/a': chunkA, '/b': chunkB }

    server = createServer((req, res) => {
      const body = byUrl[req.url ?? '']
      res.writeHead(200, { 'Content-Length': String(body.length) })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    const parts: PkgEntry[] = [
      { url: `${baseUrl}/a`, md5: createHash('md5').update(chunkA).digest('hex'), size: String(chunkA.length), decompressed_size: '0' },
      { url: `${baseUrl}/b`, md5: createHash('md5').update(chunkB).digest('hex'), size: String(chunkB.length), decompressed_size: '0' }
    ]

    await reassembleParts(parts, destZip, partsDir)

    const got = await readFile(destZip)
    expect(got.equals(Buffer.concat([chunkA, chunkB]))).toBe(true)
  })

  it('downloads parts in array order even when later parts would resolve faster', async () => {
    const dir = await makeTempDir()
    const partsDir = join(dir, 'parts')
    const destZip = join(dir, 'out.zip')

    const chunkA = Buffer.from('slow-part-A')
    const chunkB = Buffer.from('fast-part-B')
    const byUrl: Record<string, Buffer> = { '/slow': chunkA, '/fast': chunkB }

    server = createServer((req, res) => {
      const body = byUrl[req.url ?? '']
      const delay = req.url === '/slow' ? 30 : 0
      setTimeout(() => {
        res.writeHead(200, { 'Content-Length': String(body.length) })
        res.end(body)
      }, delay)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`

    // Array order is slow-part-A then fast-part-B.
    const parts: PkgEntry[] = [
      { url: `${baseUrl}/slow`, md5: createHash('md5').update(chunkA).digest('hex'), size: String(chunkA.length), decompressed_size: '0' },
      { url: `${baseUrl}/fast`, md5: createHash('md5').update(chunkB).digest('hex'), size: String(chunkB.length), decompressed_size: '0' }
    ]

    await reassembleParts(parts, destZip, partsDir)

    const got = await readFile(destZip)
    expect(got.equals(Buffer.concat([chunkA, chunkB]))).toBe(true)
  })
})
