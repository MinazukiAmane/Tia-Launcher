import { afterEach, expect, it, vi } from 'vitest'
import { createStatusReader, hasCustomServer } from '../../src/main/serverStatus'
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

it.each(['-port 50601', '-ip dev.example.test', '-ip "127.0.0.1" -port 12345', '-lang na_en -port 50601'])('does not apply production maintenance to explicit client target: %s', async (command) => {
 const fetcher = vi.fn()
 vi.stubGlobal('fetch', fetcher)
 expect(hasCustomServer(command)).toBe(true)
 expect(await createStatusReader('https://api.example.test')(command)).toEqual({ status: 'custom', checkedAt: null })
 expect(fetcher).not.toHaveBeenCalled()
})
it.each([null, '', '-lang na_en', '-port', '-port nope', '-port 0', '-port 65536', '-ip', '-ip -lang na_en', '-ip "unterminated', 'env -port 50601 %command%', '-port=50601'])('does not bypass maintenance for unrelated or malformed options: %s', (command) => {
 expect(hasCustomServer(command)).toBe(false)
})
it('keeps the official cached status after switching back from a custom server', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'maintenance', checkedAt: new Date().toISOString() }) }))
 const read = createStatusReader('https://api.example.test')
 expect((await read()).status).toBe('maintenance')
 expect((await read('-port 50601')).status).toBe('custom')
 expect((await read()).status).toBe('maintenance')
})
