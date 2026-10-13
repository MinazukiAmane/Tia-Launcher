import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
const mocks = vi.hoisted(() => ({ bypass: vi.fn(), verify: vi.fn(), launch: vi.fn(), dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.dir }, dialog: {}, shell: {}, ipcMain: {} }))
vi.mock('./developerAccess', () => ({ developerAccess: { useBypass: mocks.bypass } }))
vi.mock('./developerHardware', () => ({ developerHardware: {} }))
vi.mock('./gameManager', () => ({
  isApprovedInstallDir: async () => true,
  isOperationInProgress: () => false,
  verifyInstall: mocks.verify, launchGame: mocks.launch
}))
import { handleLaunchGame } from './ipc'
beforeEach(async () => { vi.clearAllMocks(); mocks.dir = await mkdtemp(join(tmpdir(), 'tia-dev-ipc-')) })
afterEach(async () => { await rm(mocks.dir, { recursive: true, force: true }) })
it('skips prelaunch integrity only after the server-backed hardware authorization check succeeds', async () => {
  mocks.bypass.mockResolvedValueOnce(true)
  expect(await handleLaunchGame(null, mocks.dir)).toEqual({ launched: true })
  expect(mocks.bypass).toHaveBeenCalledOnce(); expect(mocks.verify).not.toHaveBeenCalled()
  expect(mocks.launch).toHaveBeenCalledWith(mocks.dir)
})
it('keeps integrity blocking a modified client when developer authorization fails or expires', async () => {
  mocks.bypass.mockResolvedValueOnce(false)
  mocks.verify.mockResolvedValueOnce({ ok: false, corruptFiles: ['Bin/cstrike-online.exe'], missingFiles: [] })
  expect(await handleLaunchGame(null, mocks.dir)).toMatchObject({ launched: false })
  expect(mocks.verify).toHaveBeenCalledWith(mocks.dir, true); expect(mocks.launch).not.toHaveBeenCalled()
})
