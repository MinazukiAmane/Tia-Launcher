import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'fs/promises'
import { patch } from '@bsdiff-rust/node'
import { bspatch } from './bsdiffAdapter'
vi.mock('@bsdiff-rust/node', () => ({ patch: vi.fn(async () => {}) }))
vi.mock('./logger', () => ({ logError: vi.fn() }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, readFile: vi.fn(), rm: vi.fn(actual.rm) }
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
describe('patch output file access', () => {
  it('retries a temporarily locked output without applying the delta twice', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' })).mockResolvedValueOnce(Buffer.from('patched output'))
    expect(await bspatch(Buffer.from('old'), Buffer.from('delta'))).toEqual(Buffer.from('patched output'))
    expect(patch).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledTimes(2)
  })
  it('retries UNKNOWN output access errors on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('unknown open error'), { code: 'UNKNOWN' })).mockResolvedValueOnce(Buffer.from('patched output'))
    expect(await bspatch(Buffer.from('old'), Buffer.from('delta'))).toEqual(Buffer.from('patched output'))
    expect(patch).toHaveBeenCalledTimes(1)
  })
  it('preserves the original output error if temp cleanup is locked', async () => {
    const error = Object.assign(new Error('output missing'), { code: 'ENOENT' })
    vi.mocked(readFile).mockRejectedValueOnce(error)
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('cleanup locked'), { code: 'EBUSY' }))
    await expect(bspatch(Buffer.from('old'), Buffer.from('delta'))).rejects.toBe(error)
    const dir = vi.mocked(rm).mock.calls.at(-1)![0]
    await rm(dir, { recursive: true, force: true })
    expect(readFile).toHaveBeenCalledTimes(1)
  })
})
