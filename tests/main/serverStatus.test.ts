import { afterEach, expect, it, vi } from 'vitest'
import { createStatusReader } from '../../src/main/serverStatus'
import { blocksBrowserShortcut } from '../../src/main/windowShortcuts'
afterEach(() => vi.unstubAllGlobals())
it('deduplicates requests and caches a validated result without revealing the master address', async () => {
  const result = { status: 'online', checkedAt: new Date().toISOString() }
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => result })
  vi.stubGlobal('fetch', fetcher)
  const read = createStatusReader('https://api.example.test')
  expect(await Promise.all([read(), read()])).toEqual([result, result])
  expect(await read()).toEqual(result)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]![0]).toBe('https://api.example.test/api/game_status')
})
it.each([null, { status: 'online', checkedAt: 'bad' }, { status: 'online', checkedAt: new Date(0).toISOString() }, { status: 'invented', checkedAt: new Date().toISOString() }])('does not claim online from invalid or stale responses: %j', async (value) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => value }))
  expect((await createStatusReader('https://api.example.test')()).status).toBe('unknown')
})
it('returns unknown when the status API is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  expect((await createStatusReader('https://api.example.test')()).status).toBe('unknown')
})
it('blocks browser reload variants and production inspector shortcuts', () => {
  for (const input of [{ key: 'F5' }, { key: 'F5', control: true }, { key: 'R', control: true }, { key: 'r', control: true, shift: true }, { key: 'r', meta: true, shift: true }]) expect(blocksBrowserShortcut(input, true)).toBe(true)
  for (const input of [{ key: 'F12' }, { key: 'I', control: true, shift: true }, { key: 'j', meta: true, alt: true }]) {
    expect(blocksBrowserShortcut(input, true)).toBe(true)
    expect(blocksBrowserShortcut(input, false)).toBe(false)
  }
  expect(blocksBrowserShortcut({ key: 'r' }, true)).toBe(false)
  expect(blocksBrowserShortcut({ key: 'c', control: true }, true)).toBe(false)
})
