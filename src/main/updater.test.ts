import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('initialUpdateState', () => {
  it('starts with no available update, no progress, not downloaded, no error', async () => {
    const { initialUpdateState } = await import('./updater')
    expect(initialUpdateState()).toEqual({
      available: null,
      progress: null,
      downloaded: false,
      error: null
    })
  })
})

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  operationInProgress: false
}))

vi.mock('./gameManager', () => ({
  isOperationInProgress: () => mocks.operationInProgress
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/mock' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers[channel] = fn
    }
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn()
  }
}))

describe('quit-and-install guard', () => {
  const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow

  beforeEach(async () => {
    mocks.operationInProgress = false
    vi.clearAllMocks()
    const { initAutoUpdater } = await import('./updater')
    initAutoUpdater(fakeWin)
  })

  it('refuses to quit and install while an install/patch operation is in progress', async () => {
    mocks.operationInProgress = true
    const { IPC_UPDATE } = await import('./updater')
    const { autoUpdater } = await import('electron-updater')

    await expect(mocks.handlers[IPC_UPDATE.QUIT_AND_INSTALL]()).rejects.toThrow(/in progress/i)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('allows quit and install when nothing is in progress', async () => {
    mocks.operationInProgress = false
    const { IPC_UPDATE } = await import('./updater')
    const { autoUpdater } = await import('electron-updater')

    await mocks.handlers[IPC_UPDATE.QUIT_AND_INSTALL]()
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
