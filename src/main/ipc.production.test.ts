import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
const mocks = vi.hoisted(() => ({ verify: vi.fn(), launch: vi.fn(), dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.dir }, dialog: {}, shell: {}, ipcMain: {} }))
vi.mock('./gameManager', () => ({
  isApprovedInstallDir: async () => true,
  isOperationInProgress: () => false,
  verifyInstall: mocks.verify, launchGame: mocks.launch
}))
import { handleLaunchGame } from './ipc'
beforeEach(async () => { vi.clearAllMocks(); mocks.dir = await mkdtemp(join(tmpdir(), 'tia-dev-ipc-')) })
afterEach(async () => { await rm(mocks.dir, { recursive: true, force: true }) })
it('always verifies the production client before launch', async () => {
  mocks.verify.mockResolvedValueOnce({ ok: true, corruptFiles: [], missingFiles: [] })
  expect(await handleLaunchGame(null, mocks.dir)).toEqual({ launched: true })
  expect(mocks.verify).toHaveBeenCalledWith(mocks.dir, true)
  expect(mocks.launch).toHaveBeenCalledWith(mocks.dir)
})
it('refuses a modified production client with no developer bypass', async () => {
  mocks.verify.mockResolvedValueOnce({ ok: false, corruptFiles: ['Bin/cstrike-online.exe'], missingFiles: [] })
  expect(await handleLaunchGame(null, mocks.dir)).toMatchObject({ launched: false })
  expect(mocks.verify).toHaveBeenCalledWith(mocks.dir, true)
  expect(mocks.launch).not.toHaveBeenCalled()
})
