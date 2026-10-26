import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { prepareNativeGameLaunch } from '../../../src/main/launcher/nativeGameLaunch'
vi.mock('electron', () => ({ app: { isPackaged: false } }))
const fixture = join(process.cwd(), 'tests/fixtures/flags-fixture-x64.exe')
const hostPath = (value: string): string => process.platform === 'win32' ? value : value.slice(2).replace(/\\/g, '/')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
it('uses the packaged silent runtime and waits for its explicit acknowledgement', async () => {
  const client = await prepareNativeGameLaunch(fixture, ['two words'])
  cleanups.push(client.cleanup)
  expect(client.executable).toBe(join(process.cwd(), 'build/native/cedar/cedar-start-x64.exe'))
  expect(client.args.at(-1)).toBe('two words')
  const report = hostPath(client.args[0])
  await writeFile(report, 'ready\n')
  await client.ready()
  expect(await readFile(report, 'utf8')).toBe('ready\n')
  await client.cleanup()
  await expect(stat(dirname(report))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('surfaces runtime startup errors through the launcher instead of a console', async () => {
  const client = await prepareNativeGameLaunch(fixture, [])
  cleanups.push(client.cleanup)
  await writeFile(hostPath(client.args[0]), 'error: Client version unsupported\n')
  await expect(client.ready()).rejects.toThrow('Client version unsupported')
})
