import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, unlink } from 'fs/promises'
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
