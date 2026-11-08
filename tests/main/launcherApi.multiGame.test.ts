import { afterEach, expect, it, vi } from 'vitest'
import { fetchLauncherInfo } from '../../src/main/launcherApi'
import { LAUNCHER_API_BASE_URL } from '../../src/main/catalog'
afterEach(() => vi.unstubAllGlobals())
const game = (biz: string) => ({ game: { id: biz, biz }, main: { major: null, patches: [], required_client_version: '' } })
it('requests the selected biz from the new endpoint and selects its matching entry', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request) => Response.json({ retcode: 0, data: { game_packages: [game('csore_global'), game('cedar_global')] } }))
  vi.stubGlobal('fetch', fetch)
  const info = await fetchLauncherInfo(LAUNCHER_API_BASE_URL, 'cedar_global')
  expect(info.game.biz).toBe('cedar_global')
  expect(fetch.mock.calls[0]?.[0]).toBe('https://sg-tia-api.serenetia.com/api/launcher_info?game_biz=cedar_global')
})
it('rejects metadata for another game instead of installing it in the selected folder', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ retcode: 0, data: { game_packages: [game('csore_global')] } })))
  await expect(fetchLauncherInfo('https://wrong-game.test', 'cedar_global')).rejects.toThrow(/selected game/)
})
