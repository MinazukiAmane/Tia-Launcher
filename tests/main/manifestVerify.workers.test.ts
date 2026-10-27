import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { verifyAgainstManifest, type VerifyMetrics } from '../../src/main/manifestVerify'
import { VerificationWorkers } from '../../src/main/verificationWorkers'

it('caches parallel large-file hashes and rejects changed content in manifest order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tia-parallel-integrity-'))
  try {
    const files = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const bytes = Buffer.alloc(512 * 1024 + i, i)
      const path = String(i); await writeFile(join(root, path), bytes)
      return { path, size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') }
    }))
    const metrics: VerifyMetrics[] = []
    const options = { onMetrics: (metric: VerifyMetrics) => metrics.push(metric) }
    expect((await verifyAgainstManifest(root, { files }, true, options)).ok).toBe(true)
    expect(metrics.at(-1)).toMatchObject({ hashedFiles: 6, cacheHits: 0 })
    expect((await verifyAgainstManifest(root, { files }, true, options)).ok).toBe(true)
    expect(metrics.at(-1)).toMatchObject({ hashedFiles: 0, cacheHits: 6, hashedBytes: 0 })
    for (const i of [4, 1]) {
      const path = join(root, String(i)); const before = await stat(path)
      await writeFile(path, Buffer.alloc(files[i].size, 99))
      await utimes(path, before.atime, before.mtime)
    }
    expect(await verifyAgainstManifest(root, { files }, true, options)).toEqual({ ok: false, corruptFiles: ['1', '4'], missingFiles: [] })
    expect(metrics.at(-1)).toMatchObject({ hashedFiles: 2, cacheHits: 4 })
    expect((await verifyAgainstManifest(root, { files }, false, options)).ok).toBe(false)
    expect(metrics.at(-1)).toMatchObject({ hashedFiles: 6, cacheHits: 0 })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not cache a file that changes after hashing but before the final metadata check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tia-integrity-race-'))
  const original = VerificationWorkers.prototype.hash
  try {
    const bytes = Buffer.alloc(512 * 1024, 1); const path = join(root, 'asset')
    await writeFile(path, bytes)
    const before = await stat(path)
    const hook = vi.spyOn(VerificationWorkers.prototype, 'hash').mockImplementationOnce(async function (this: VerificationWorkers, target: string) {
      const digest = await original.call(this, target)
      await writeFile(target, Buffer.alloc(bytes.length, 2))
      await utimes(target, before.atime, before.mtime)
      return digest
    })
    const manifest = { files: [{ path: 'asset', size: bytes.length, md5: createHash('md5').update(bytes).digest('hex') }] }
    expect((await verifyAgainstManifest(root, manifest, true)).corruptFiles).toEqual(['asset'])
    hook.mockRestore()
    const metrics: VerifyMetrics[] = []
    expect((await verifyAgainstManifest(root, manifest, true, { onMetrics: metric => metrics.push(metric) })).corruptFiles).toEqual(['asset'])
    expect(metrics[0]).toMatchObject({ hashedFiles: 1, cacheHits: 0 })
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
})
