import { afterEach, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { VerificationWorkers, mapBounded } from '../../src/main/verificationWorkers'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('hashes concurrent jobs in real Node workers and recovers from a missing input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tia-hash-workers-')); roots.push(root)
  const inputs = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const bytes = Buffer.alloc(512 * 1024 + i, i)
    const path = join(root, String(i)); await writeFile(path, bytes)
    return { path, digest: createHash('md5').update(bytes).digest('hex') }
  }))
  const pool = new VerificationWorkers(2)
  try {
    await expect(pool.hash(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await Promise.all(inputs.map(input => pool.hash(input.path)))).toEqual(inputs.map(input => input.digest))
  } finally { await pool.close() }
  await expect(pool.hash(inputs[0].path)).rejects.toThrow('closed')
})

it('drains in-flight work after failure without starting queued tasks', async () => {
  const started: number[] = []; let active = 0
  const result = mapBounded([0, 1, 2, 3], 2, async value => {
    started.push(value); active++
    try {
      await new Promise(resolve => setTimeout(resolve, value === 0 ? 5 : 30))
      if (value === 0) throw new Error('disk failed')
      return value
    } finally { active-- }
  })
  await expect(result).rejects.toThrow('disk failed')
  expect(active).toBe(0); expect(started).toEqual([0, 1])
})
