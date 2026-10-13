import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('initialUpdateState', () => {
  it('starts with no available update, no progress, not downloaded, no error', async () => {
    const { initialUpdateState } = await import('./updater')
    expect(initialUpdateState()).toEqual({
      versionStatus: 'current',
      available: null,
      progress: null,
      downloaded: false,
      downloading: false,
      downloadProgress: null,
      error: null
    })
  })
})

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
  events: {} as Record<string, (...args: any[]) => void>,
  packaged: false,
  operationInProgress: false
}))

vi.mock('./gameManager', () => ({
  isOperationInProgress: () => mocks.operationInProgress
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged }, getPath: () => '/mock' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers[channel] = fn
    }
  }
}))

vi.mock('./logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn((event: string, callback: (...args: any[]) => void) => { mocks.events[event] = callback }),
    disableDifferentialDownload: false,
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

describe('updater download failures and retries', () => {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.events = {}
    const { autoUpdater } = await import('electron-updater')
    vi.mocked(autoUpdater.downloadUpdate).mockReset().mockResolvedValue([])
    autoUpdater.disableDifferentialDownload = false
    const { initAutoUpdater } = await import('./updater')
    initAutoUpdater(win)
    mocks.events['update-available']({ version: 'fixture-new' })
  })

  it('stores byte counts and speed in the snapshot so a restored renderer sees current progress', async () => {
    const { IPC_UPDATE } = await import('./updater')
    mocks.events['download-progress']({ percent: 10, transferred: 1024, total: 10240, bytesPerSecond: 512 })
    const state = mocks.handlers[IPC_UPDATE.GET_STATE]() as import('./updater').UpdateState
    expect(state.downloading).toBe(true)
    expect(state.downloadProgress).toMatchObject({ percent: 10, transferred: 1024, total: 10240, bytesPerSecond: 512 })
    expect(state.downloadProgress?.updatedAt).toBeGreaterThan(0)
  })

  it('clears stale percentage and surfaces an error after a rejected download even without an error event', async () => {
    const { autoUpdater } = await import('electron-updater')
    const { IPC_UPDATE } = await import('./updater')
    vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
      mocks.events['download-progress']({ percent: 10, transferred: 10, total: 100, bytesPerSecond: 10 })
      throw new Error('network disconnected')
    })
    await expect(mocks.handlers[IPC_UPDATE.START_DOWNLOAD](null, false)).rejects.toThrow('network disconnected')
    expect(mocks.handlers[IPC_UPDATE.GET_STATE]()).toMatchObject({ progress: null, downloadProgress: null, downloading: false, error: 'network disconnected' })
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_UPDATE.ERROR, 'network disconnected')
  })

  it('allows a full download retry after failure and restores normal differential behavior afterward', async () => {
    const { autoUpdater } = await import('electron-updater')
    const { IPC_UPDATE } = await import('./updater')
    vi.mocked(autoUpdater.downloadUpdate).mockRejectedValueOnce(new Error('bad differential transfer'))
    await expect(mocks.handlers[IPC_UPDATE.START_DOWNLOAD](null, false)).rejects.toThrow()
    vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
      expect(autoUpdater.disableDifferentialDownload).toBe(true)
      mocks.events['update-downloaded']()
      return ['fixture.exe']
    })
    await mocks.handlers[IPC_UPDATE.START_DOWNLOAD](null, true)
    expect(autoUpdater.disableDifferentialDownload).toBe(false)
    expect(mocks.handlers[IPC_UPDATE.GET_STATE]()).toMatchObject({ error: null, downloaded: true, downloading: false, progress: 100 })
  })

  it('starts a single download when the action is requested twice', async () => {
    const { autoUpdater } = await import('electron-updater')
    const { IPC_UPDATE } = await import('./updater')
    let finish!: (files: string[]) => void
    vi.mocked(autoUpdater.downloadUpdate).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const first = mocks.handlers[IPC_UPDATE.START_DOWNLOAD](null, false)
    const second = mocks.handlers[IPC_UPDATE.START_DOWNLOAD](null, false)
    expect(second).toBe(first)
    await Promise.resolve()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    finish(['fixture.exe'])
    await first
  })

  it('keeps automatic download and install disabled', async () => {
    const { autoUpdater } = await import('electron-updater')
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })
})

describe('mandatory launcher version checks', () => {
  const win = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
  beforeEach(async () => {
    vi.useFakeTimers()
    mocks.packaged = true
    const { autoUpdater } = await import('electron-updater')
    vi.mocked(autoUpdater.checkForUpdates).mockReset().mockResolvedValue(null)
    const { initAutoUpdater } = await import('./updater')
    initAutoUpdater(win)
  })
  afterEach(() => { mocks.packaged = false; vi.clearAllTimers(); vi.useRealTimers() })

  it('blocks startup and errors, then unlocks only after a successful current-version event', async () => {
    const { assertLauncherCurrent } = await import('./launcherVersionGate')
    const { IPC_UPDATE } = await import('./updater')
    expect(() => assertLauncherCurrent()).toThrow(/verify/)
    await mocks.handlers[IPC_UPDATE.CHECK]()
    expect(mocks.handlers[IPC_UPDATE.GET_STATE]()).toMatchObject({ versionStatus: 'failed' })
    expect(() => assertLauncherCurrent()).toThrow(/verify/)
    mocks.events['update-not-available']({ version: '1.4.3' })
    expect(() => assertLauncherCurrent()).not.toThrow()
    expect(mocks.handlers[IPC_UPDATE.GET_STATE]()).toMatchObject({ versionStatus: 'current', error: null })
  })

  it('keeps the old launcher locked after downloading, including after an update error', async () => {
    const { assertLauncherCurrent } = await import('./launcherVersionGate')
    const { IPC_UPDATE } = await import('./updater')
    await mocks.handlers[IPC_UPDATE.CHECK]()
    mocks.events['update-available']({ version: '1.5.0' })
    expect(() => assertLauncherCurrent()).toThrow(/latest/)
    mocks.events['update-downloaded']()
    expect(mocks.handlers[IPC_UPDATE.GET_STATE]()).toMatchObject({ versionStatus: 'required', downloaded: true })
    expect(() => assertLauncherCurrent()).toThrow(/latest/)
    mocks.events.error(new Error('install failed'))
    expect(() => assertLauncherCurrent()).toThrow(/latest/)
  })
})
