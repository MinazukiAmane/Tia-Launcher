import { afterEach, expect, it, vi } from 'vitest'
import { fetchLauncherInfo } from '../../src/main/launcherApi'
import { fetchVersionManifest } from '../../src/main/manifestVerify'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const info = (biz: string) => Response.json({ retcode: 0, data: { game_packages: [{ game: { biz }, main: { major: null, patches: [], required_client_version: '' } }] } })

it('reuses recent metadata for Play, isolates titles, and refreshes manual or expired requests', async () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now)
  const fetch = vi.fn(async (url: string) => info(url.includes('cedar_global') ? 'cedar_global' : 'csore_global'))
  vi.stubGlobal('fetch', fetch)
  const api = 'https://short-cache.test'
  const first = await fetchLauncherInfo(api, 'csore_global'); first.game.biz = 'mutated'
  expect((await fetchLauncherInfo(api, 'csore_global', { forPlay: true })).game.biz).toBe('csore_global')
  expect(fetch).toHaveBeenCalledTimes(1)
  await fetchLauncherInfo(api, 'cedar_global', { forPlay: true }); expect(fetch).toHaveBeenCalledTimes(2)
  await fetchLauncherInfo(api, 'csore_global'); expect(fetch).toHaveBeenCalledTimes(3)
  now += 30_001
  await fetchLauncherInfo(api, 'csore_global', { forPlay: true }); expect(fetch).toHaveBeenCalledTimes(4)
})

it('caches only successful manifests briefly and keeps manual verification fresh', async () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now)
  const fetch = vi.fn(async () => Response.json({ version: '1', files: [{ path: 'a', md5: 'hash', size: 1 }] }))
  vi.stubGlobal('fetch', fetch)
  const url = 'https://manifest-short-cache.test/list'
  const first = await fetchVersionManifest(url); first!.files[0].md5 = 'mutated'
  expect((await fetchVersionManifest(url, 4000, true))!.files[0].md5).toBe('hash')
  expect(fetch).toHaveBeenCalledTimes(1)
  await fetchVersionManifest(url); expect(fetch).toHaveBeenCalledTimes(2)
  now += 30_001
  await fetchVersionManifest(url, 4000, true); expect(fetch).toHaveBeenCalledTimes(3)
  fetch.mockImplementation(async () => new Response('', { status: 503 }))
  expect(await fetchVersionManifest('https://manifest-short-cache.test/error', 4000, true)).toBeNull()
  expect(await fetchVersionManifest('https://manifest-short-cache.test/error', 4000, true)).toBeNull()
  expect(fetch).toHaveBeenCalledTimes(5)
})
