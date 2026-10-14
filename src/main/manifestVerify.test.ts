
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { createServer, type Server } from 'http'
import {
  findVersionBlock,
  fetchVersionManifest,
  verifyAgainstManifest,
  type VersionManifest
} from './manifestVerify'
import type { GamePackageEntry } from './launcherApi'

function md5(buf: Buffer | string): string {
  return createHash('md5').update(buf).digest('hex')
}

let dirs: string[] = []
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'csore-manifest-verify-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

function makeInfo(majorVersion: string | null, patchVersions: string[] = []): GamePackageEntry {
  return {
    game: { id: '1', biz: 'csore_global' },
    main: {
      major: majorVersion
        ? { version: majorVersion, game_pkgs: [], res_list_url: `https://example.test/manifest/${majorVersion}` }
        : null,
      patches: patchVersions.map((v) => ({ version: v, game_pkgs: [], res_list_url: `https://example.test/manifest/${v}` })),
      required_client_version: '1.0.0'
    }
  }
}

describe('findVersionBlock', () => {
  it('matches main.major when its version equals the installed version', () => {
    const info = makeInfo('1.2.0')
    expect(findVersionBlock(info, '1.2.0')?.res_list_url).toBe('https://example.test/manifest/1.2.0')
  })

  it('matches a patch block when the installed version is older but listed', () => {
    const info = makeInfo('1.2.0', ['1.1.0', '1.0.0'])
    expect(findVersionBlock(info, '1.1.0')?.res_list_url).toBe('https://example.test/manifest/1.1.0')
  })

  it('returns null when nothing matches', () => {
    const info = makeInfo('1.2.0', ['1.1.0'])
    expect(findVersionBlock(info, '0.0.1')).toBeNull()
  })

  it('returns null (not a crash) when main.major is null', () => {
    expect(findVersionBlock(makeInfo(null), '1.0.0')).toBeNull()
  })
})

describe('fetchVersionManifest', () => {
  let server: Server
  let baseUrl: string

  afterEach(() => server?.close())

  it('returns null (never throws) for undefined/empty url, a non-OK response, or a malformed body', async () => {
    expect(await fetchVersionManifest(undefined)).toBeNull()

    server = createServer((req, res) => {
      if (req.url === '/not-ready') {
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'not ready' }))
      } else if (req.url === '/malformed') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ version: '1.0.0' })) // no `files` array
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${addr.port}`

    expect(await fetchVersionManifest(`${baseUrl}/not-ready`)).toBeNull()
    expect(await fetchVersionManifest(`${baseUrl}/malformed`)).toBeNull()
    expect(await fetchVersionManifest(`${baseUrl}/missing`)).toBeNull()
    expect(await fetchVersionManifest('http://127.0.0.1:1/unreachable')).toBeNull()
  })

  it('returns the parsed manifest for a real 200 response', async () => {
    const manifest: VersionManifest = { version: '1.0.0', files: [{ path: 'a.txt', md5: 'x', size: 1 }] }
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(manifest))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('server did not bind')
    const got = await fetchVersionManifest(`http://127.0.0.1:${addr.port}/manifest`)
    expect(got).toEqual(manifest)
  })
})

describe('verifyAgainstManifest', () => {
  it('passes when every file matches, flags size mismatches without reading the file, and flags missing files', async () => {
    const dir = await tmp()
    const good = Buffer.from('a'.repeat(5000))
    await mkdir(join(dir, 'Bin'), { recursive: true })
    await writeFile(join(dir, 'Bin', 'good.dll'), good)
    await writeFile(join(dir, 'Bin', 'wrong-size.dll'), Buffer.from('short'))

    const manifest: VersionManifest = {
      version: '1.0.0',
      files: [
        { path: 'Bin/good.dll', md5: md5(good), size: good.length },
        { path: 'Bin/wrong-size.dll', md5: md5(Buffer.alloc(9999)), size: 9999 },
        { path: 'Bin/missing.dll', md5: 'anything', size: 1 }
      ]
    }

    const result = await verifyAgainstManifest(dir, manifest)
    expect(result.ok).toBe(false)
    expect(result.corruptFiles).toEqual(['Bin/wrong-size.dll'])
    expect(result.missingFiles).toEqual(['Bin/missing.dll'])
  })

  it('catches a same-size tampered file (content changed, length unchanged)', async () => {
    const dir = await tmp()
    const original = Buffer.from('original content, exact length matters here')
    const tampered = Buffer.from('TAMPEREDxcontent, exact length matters here')
    expect(tampered.length).toBe(original.length)
    await writeFile(join(dir, 'file.bin'), tampered)

    const manifest: VersionManifest = {
      version: '1.0.0',
      files: [{ path: 'file.bin', md5: md5(original), size: original.length }]
    }

    const result = await verifyAgainstManifest(dir, manifest)
    expect(result.ok).toBe(false)
    expect(result.corruptFiles).toEqual(['file.bin'])
  })

  it('reports ok for an empty manifest file list', async () => {
    const dir = await tmp()
    const result = await verifyAgainstManifest(dir, { version: '1.0.0', files: [] })
    expect(result).toEqual({ ok: true, corruptFiles: [], missingFiles: [] })
  })
})

it('ignores changed or missing runtime logs in an existing server manifest', async () => {
  const dir = await tmp()
  await writeFile(join(dir, 'Error.log'), 'runtime output')
  await writeFile(join(dir, 'game.dat'), 'game')
  expect(await verifyAgainstManifest(dir, { files: [
    { path: 'Error.log', md5: md5('old output') },
    { path: 'Missing.LOG', md5: md5('missing') },
    { path: 'game.dat', md5: md5('game') }
  ] })).toEqual({ ok: true, corruptFiles: [], missingFiles: [] })
})

it('checks the canonical Renderer.dll and ignores the conflicting lowercase alias', async () => {
  const dir = await tmp()
  await mkdir(join(dir, 'Bin'))
  const manifest = { files: [
    { path: 'Bin/Renderer.dll', md5: md5('correct DLL'), size: 11 },
    { path: 'Bin/renderer.dll', md5: md5('legacy DLL'), size: 10 }
  ] }
  await writeFile(join(dir, 'Bin/Renderer.dll'), 'wrong DLL')
  expect((await verifyAgainstManifest(dir, manifest)).corruptFiles).toEqual(['Bin/Renderer.dll'])

  await writeFile(join(dir, 'Bin/Renderer.dll'), 'correct DLL')
  for (const quick of [false, true, true]) {
    expect(await verifyAgainstManifest(dir, manifest, quick)).toEqual({ ok: true, corruptFiles: [], missingFiles: [] })
  }
})

it('still verifies a lowercase-only renderer from an older manifest', async () => {
  const dir = await tmp()
  const result = await verifyAgainstManifest(dir, { files: [
    { path: 'Bin/renderer.dll', md5: md5('legacy DLL') }
  ] })
  expect(result.missingFiles).toEqual(['Bin/renderer.dll'])
  expect(result.ok).toBe(false)
})
