vi.mock('../../src/shared/migrationKeys.json', () => ({ default: [] }))
vi.mock('../../migration/electron/ipcSecurity', () => ({ assertTrustedSender: vi.fn() }))
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('initialUpdateState', () => {
  it('starts with no available update, no progress, not downloaded, no error', async () => {
    const { initialUpdateState } = await import('../../migration/electron/updater')
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


vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.packaged }, getPath: () => '/mock', getVersion: () => '1.99.0' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers[channel] = fn
    }
  }
}))

vi.mock('../../migration/electron/logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

vi.mock('electron-updater', () => ({
  NsisUpdater: class {},
  DebUpdater: class {},
  PacmanUpdater: class {},
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
    const { initAutoUpdater } = await import('../../migration/electron/updater')
    initAutoUpdater(fakeWin, () => mocks.operationInProgress)
  })

  it('refuses to quit and install while an install/patch operation is in progress', async () => {
    mocks.operationInProgress = true
    const { IPC_UPDATE } = await import('../../migration/electron/updater')
    const { autoUpdater } = await import('electron-updater')

    await expect(mocks.handlers[IPC_UPDATE.QUIT_AND_INSTALL]()).rejects.toThrow(/in progress/i)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses to replace the launcher while a game is running', async () => {
    const { initAutoUpdater, IPC_UPDATE } = await import('../../migration/electron/updater')
    const { autoUpdater } = await import('electron-updater')
    initAutoUpdater(fakeWin, () => true)
    await expect(mocks.handlers[IPC_UPDATE.QUIT_AND_INSTALL]()).rejects.toThrow(/in progress/i)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('allows quit and install when nothing is in progress', async () => {
    mocks.operationInProgress = false
    const { IPC_UPDATE } = await import('../../migration/electron/updater')
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
    const { initAutoUpdater } = await import('../../migration/electron/updater')
    initAutoUpdater(win)
    mocks.events['update-available']({ version: 'fixture-new' })
  })

  it('stores byte counts and speed in the snapshot so a restored renderer sees current progress', async () => {
    const { IPC_UPDATE } = await import('../../migration/electron/updater')
    mocks.events['download-progress']({ percent: 10, transferred: 1024, total: 10240, bytesPerSecond: 512 })
    const state = mocks.handlers[IPC_UPDATE.GET_STATE]() as import('../../src/shared/launcherApiTypes').UpdateState
    expect(state.downloading).toBe(true)
    expect(state.downloadProgress).toMatchObject({ percent: 10, transferred: 1024, total: 10240, bytesPerSecond: 512 })
    expect(state.downloadProgress?.updatedAt).toBeGreaterThan(0)
  })

  it('clears stale percentage and surfaces an error after a rejected download even without an error event', async () => {
    const { autoUpdater } = await import('electron-updater')
    const { IPC_UPDATE } = await import('../../migration/electron/updater')
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
    const { IPC_UPDATE } = await import('../../migration/electron/updater')
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
    const { IPC_UPDATE } = await import('../../migration/electron/updater')
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

  it('keeps the macOS download event path when downloadUpdate returns no paths', async () => {
    const migration = await import('../../migration/electron/frameworkMigration')
    const prepare = vi.spyOn(migration, 'prepareFrameworkMigration').mockResolvedValue(undefined)
    try {
      const { autoUpdater } = await import('electron-updater')
      const { IPC_UPDATE } = await import('../../migration/electron/updater')
      mocks.events['update-available']({ version: '2.0.0' })
      vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
        mocks.events['update-downloaded']({ downloadedFile: '/cache/Tia Launcher.zip' })
        return []
      })
      await mocks.handlers[IPC_UPDATE.START_DOWNLOAD](null, false)
      await mocks.handlers[IPC_UPDATE.QUIT_AND_INSTALL]()
      expect(prepare).toHaveBeenCalledWith('/cache/Tia Launcher.zip', '2.0.0', expect.any(Function), expect.any(Function))
    } finally { prepare.mockRestore() }
  })

  it('keeps the downloaded installer when a repeated check reports the same version', async () => {
    const migration = await import('../../migration/electron/frameworkMigration')
    const prepare = vi.spyOn(migration, 'prepareFrameworkMigration').mockResolvedValue(undefined)
    try {
      const { autoUpdater } = await import('electron-updater')
      const { IPC_UPDATE } = await import('../../migration/electron/updater')
      mocks.events['update-available']({ version: '2.0.0' })
      vi.mocked(autoUpdater.downloadUpdate).mockImplementationOnce(async () => {
        mocks.events['update-downloaded']({ downloadedFile: '/cache/Tia Launcher.zip' })
        return []
      })
      await mocks.handlers[IPC_UPDATE.START_DOWNLOAD](null, false)
      mocks.events['update-available']({ version: '2.0.0' })
      await mocks.handlers[IPC_UPDATE.QUIT_AND_INSTALL]()
      expect(prepare).toHaveBeenCalledWith('/cache/Tia Launcher.zip', '2.0.0', expect.any(Function), expect.any(Function))
    } finally { prepare.mockRestore() }
  })

  it('keeps automatic download and install disabled', async () => {
    const { autoUpdater } = await import('electron-updater')
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })
})

describe('Windows updates preserve the active launcher location', () => {
  it('pins NSIS to the running directory, including custom drives and paths with spaces', async () => {
    const { configureUpdateInstallDirectory } = await import('../../migration/electron/updater')
    for (const directory of ['C:\\Program Files\\Tia Launcher', 'D:\\Custom Apps\\Tia Launcher', 'C:\\Users\\Player\\AppData\\Local\\Programs\\Tia Launcher']) {
      const updater = {} as import('electron-updater').NsisUpdater
      configureUpdateInstallDirectory(updater, 'win32', true, directory + '\\Tia Launcher.exe')
      expect(updater.installDirectory).toBe(directory)
    }
  })
  it('does not change updater directories for development or Linux/macOS', async () => {
    const { configureUpdateInstallDirectory } = await import('../../migration/electron/updater')
    for (const [platform, packaged] of [['win32', false], ['linux', true], ['darwin', true]] as const) {
      const updater = {} as import('electron-updater').NsisUpdater
      configureUpdateInstallDirectory(updater, platform, packaged, '/usr/bin/electron')
      expect(updater.installDirectory).toBeUndefined()
    }
  })
})
