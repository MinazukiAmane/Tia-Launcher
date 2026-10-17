import { afterEach, expect, it, vi } from 'vitest'
import { fetchLauncherInfo } from '../../src/main/launcherApi'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const success = () => Response.json({ retcode: 0, message: 'OK', data: { game_packages: [{ game: { biz: 'csore_global' }, main: { major: { version: '1' } } }] } })
it('uses a short request and avoids repeating failed calls before offline Play', async () => {
 const fetch = vi.fn().mockRejectedValue(Object.assign(new Error('down'), { name: 'TimeoutError' }))
 vi.stubGlobal('fetch', fetch)
 const timeout = vi.spyOn(AbortSignal, 'timeout')
 await expect(fetchLauncherInfo('https://play-outage.example.test', 'csore_global', { forPlay: true })).rejects.toThrow('4 seconds')
 expect(fetch).toHaveBeenCalledTimes(1)
 expect(timeout).toHaveBeenCalledWith(4000)
 await expect(fetchLauncherInfo('https://play-outage.example.test', 'csore_global', { forPlay: true })).rejects.toThrow('temporarily unavailable')
 expect(fetch).toHaveBeenCalledTimes(1)
 // Explicit install/manual requests can still test the service and clear cooldown.
 fetch.mockImplementation(async () => success())
 await fetchLauncherInfo('https://play-outage.example.test', 'csore_global')
 await fetchLauncherInfo('https://play-outage.example.test', 'csore_global', { forPlay: true })
 expect(fetch).toHaveBeenCalledTimes(3)
})
