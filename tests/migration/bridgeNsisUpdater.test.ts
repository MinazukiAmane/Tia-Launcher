import { expect, it, vi } from 'vitest'
import { BridgeNsisUpdater } from '../../migration/electron/bridgeNsisUpdater'
import type { NativeBridge } from '../../migration/electron/nativeBridge'
const calls = vi.hoisted(() => [] as { command: string; args: string[] }[])
vi.mock('electron-updater', () => ({ NsisUpdater: class {
  installDirectory: string | undefined = 'C:\\Old'
  installerPath = 'C:\\cache\\update.exe'
  spawnLog(command: string, args: string[]): Promise<boolean> { calls.push({ command, args }); return Promise.resolve(true) }
} }))

it('prepares Rust arguments before quit and dispatches the installer without another async operation', async () => {
  const updater = new BridgeNsisUpdater()
  const native = { windowsArguments: vi.fn().mockResolvedValue(['/currentuser', '/D=D:\\Custom Tia']) }
  await updater.setMigrationContext({ directory: 'D:\\Custom Tia', scope: 'currentUser' }, native as unknown as NativeBridge)
  native.windowsArguments.mockImplementation(() => { throw new Error('Cannot await helper work while quitting') })
  const dispatch = updater as unknown as { spawnLog(command: string, args: string[]): Promise<boolean> }
  const result = dispatch.spawnLog('C:\\cache\\update.exe', ['--updated', '/S', '--package-file=C:\\cache\\payload'])
  expect(calls.at(-1)).toEqual({ command: 'C:\\cache\\update.exe', args: ['--updated', '/S', '--package-file=C:\\cache\\payload', '/currentuser', '/D=D:\\Custom Tia'] })
  expect(updater.installDirectory).toBeUndefined()
  expect(await result).toBe(true)
  expect(native.windowsArguments).toHaveBeenCalledTimes(1)
})

it('keeps the elevated installer path first and its destination last', async () => {
  const updater = new BridgeNsisUpdater()
  await updater.setMigrationContext({ directory: 'C:\\Program Files\\Tia', scope: 'allUsers' }, { windowsArguments: async () => ['/allusers', '/D=C:\\Program Files\\Tia'] } as unknown as NativeBridge)
  await (updater as unknown as { spawnLog(command: string, args: string[]): Promise<boolean> }).spawnLog('C:\\resources\\elevate.exe', ['C:\\cache\\update.exe', '--updated'])
  expect(calls.at(-1)?.args).toEqual(['C:\\cache\\update.exe', '--updated', '/allusers', '/D=C:\\Program Files\\Tia'])
})
