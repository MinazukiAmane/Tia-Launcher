import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, unlink, stat, utimes, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { verifyAgainstManifest } from './manifestVerify'

describe('quick verification', () => {
  it('checks first launch, caches good files, detects changes and missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csore-quick-'))
    try {
      await writeFile(join(dir, 'asset'), 'good')
      const manifest = { files: [{ path: 'asset', size: 4, md5: createHash('md5').update('good').digest('hex') }] }
      expect((await verifyAgainstManifest(dir, manifest, true)).ok).toBe(true)
      expect(JSON.parse(await readFile(join(dir, '.csore_verify_cache.json'), 'utf8')).asset).toBeTruthy()
      expect((await verifyAgainstManifest(dir, manifest, true)).ok).toBe(true)
      await writeFile(join(dir, 'asset'), 'evil')
      expect((await verifyAgainstManifest(dir, manifest, true)).corruptFiles).toEqual(['asset'])
      await unlink(join(dir, 'asset'))
      expect((await verifyAgainstManifest(dir, manifest, true)).missingFiles).toEqual(['asset'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('manual checks ignore an existing cache and reject escaping paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csore-quick-'))
    try {
      await writeFile(join(dir, 'asset'), 'evil')
      expect((await verifyAgainstManifest(dir, { files: [{ path: 'asset', md5: createHash('md5').update('good').digest('hex') }] })).ok).toBe(false)
      await expect(verifyAgainstManifest(dir, { files: [{ path: '../asset', md5: '' }] })).rejects.toThrow(/path/i)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

it('does not rewrite the cache on unchanged Play checks, but invalidates changed expected hashes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csore-quick-write-'))
  try {
    await writeFile(join(dir, 'asset'), 'good')
    const manifest = { files: [{ path: 'asset', size: 4, md5: createHash('md5').update('good').digest('hex') }] }
    await verifyAgainstManifest(dir, manifest, true)
    const cache = join(dir, '.csore_verify_cache.json')
    await utimes(cache, new Date('2000-01-01'), new Date('2000-01-01'))
    const before = (await stat(cache)).mtimeMs
    expect((await verifyAgainstManifest(dir, manifest, true)).ok).toBe(true)
    expect((await stat(cache)).mtimeMs).toBe(before)
    expect((await verifyAgainstManifest(dir, { files: [{ ...manifest.files[0], md5: createHash('md5').update('evil').digest('hex') }] }, true)).corruptFiles).toEqual(['asset'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('reports mixed failures across metadata batches in manifest order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csore-quick-batch-'))
  try {
    const hash = createHash('md5').update('good').digest('hex')
    for (const name of ['good', 'bad-hash', 'bad-size', 'good-last']) await writeFile(join(dir, name), name === 'bad-hash' ? 'evil' : 'good')
    await mkdir(join(dir, 'directory'))
    const files = ['good', 'missing', 'bad-hash', 'directory', 'bad-size', 'good-last'].map(path => ({ path, md5: hash, size: path === 'bad-size' ? 100 : 4 }))
    expect(await verifyAgainstManifest(dir, { files }, true)).toEqual({ ok: false, missingFiles: ['missing'], corruptFiles: ['bad-hash', 'directory', 'bad-size'] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
