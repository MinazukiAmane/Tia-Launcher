import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ perform: vi.fn() }))
vi.mock('electron', () => ({ app: {}, dialog: {}, ipcMain: {}, shell: {} }))
vi.mock('./gameManager', () => ({ isApprovedInstallDir: async () => true, performInstallOrUpdate: mocks.perform }))
import { makeHandleStartInstallOrUpdate } from './ipc'
beforeEach(() => vi.clearAllMocks())
it('shares one install operation for simultaneous duplicate requests, then allows resume', async () => {
  let finish!: (value: { status: 'paused' }) => void
  mocks.perform.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const handler = makeHandleStartInstallOrUpdate(() => null)
  const first = handler(undefined, '/game')
  const second = handler(undefined, '/game')
  await vi.waitFor(() => expect(mocks.perform).toHaveBeenCalledTimes(1))
  finish({ status: 'paused' })
  expect(await Promise.all([first, second])).toEqual([{ status: 'paused' }, { status: 'paused' }])
  mocks.perform.mockResolvedValueOnce({ status: 'completed' })
  expect(await handler(undefined, '/game')).toEqual({ status: 'completed' })
  expect(mocks.perform).toHaveBeenCalledTimes(2)
})
it('does not start a different installation while the first is pending', async () => {
  let finish!: (value: { status: 'completed' }) => void
  mocks.perform.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const handler = makeHandleStartInstallOrUpdate(() => null)
  const first = handler(undefined, '/game')
  await vi.waitFor(() => expect(mocks.perform).toHaveBeenCalledTimes(1))
  await expect(handler(undefined, '/other')).rejects.toThrow('current installation')
  expect(mocks.perform).toHaveBeenCalledTimes(1)
  finish({ status: 'completed' }); await first
})
it('releases the shared request after failure so retry starts a new operation', async () => {
  const handler = makeHandleStartInstallOrUpdate(() => null)
  mocks.perform.mockRejectedValueOnce(new Error('network failed'))
  await expect(handler(undefined, '/game')).rejects.toThrow('network failed')
  mocks.perform.mockResolvedValueOnce({ status: 'completed' })
  expect(await handler(undefined, '/game')).toEqual({ status: 'completed' })
})
