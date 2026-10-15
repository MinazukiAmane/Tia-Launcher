import { afterEach, expect, it, vi } from 'vitest'
import { fetchLauncherInfo } from './launcherApi'
afterEach(() => vi.unstubAllGlobals())
const success = () => Response.json({ retcode: 0, message: 'OK', data: { game_packages: [{ game: { biz: 'csore_global' }, main: {} }] } })
it('recovers after a transient metadata timeout', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' })).mockResolvedValueOnce(success())
  vi.stubGlobal('fetch', fetch)
  expect((await fetchLauncherInfo('https://example.test', 'csore_global')).game.biz).toBe('csore_global')
  expect(fetch).toHaveBeenCalledTimes(2)
})
it('limits HTTP 520 retries and reports the Cloudflare Ray', async () => {
  const fetch = vi.fn(async () => new Response('error', { status: 520, headers: { 'cf-ray': 'test-CGK' } }))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchLauncherInfo('https://example.test', 'csore_global')).rejects.toThrow('HTTP 520 (Cloudflare Ray: test-CGK)')
  expect(fetch).toHaveBeenCalledTimes(3)
})
it('does not retry authentication or API validation failures', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('denied', { status: 403 })).mockResolvedValueOnce(Response.json({ retcode: 1, message: 'invalid game', data: null }))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchLauncherInfo('https://example.test', 'csore_global')).rejects.toThrow('HTTP 403')
  await expect(fetchLauncherInfo('https://example.test', 'csore_global')).rejects.toThrow('invalid game')
  expect(fetch).toHaveBeenCalledTimes(2)
})
