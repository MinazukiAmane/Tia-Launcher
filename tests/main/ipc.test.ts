import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, realpath, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const getPathMock = vi.fn((name: string) => `/mock/${name}`)

vi.mock('electron', () => ({
  app: { getPath: (name: string) => getPathMock(name) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const cachedNewsMock = vi.fn(() => [] as import('../../src/main/news').NewsItem[])
vi.mock('../../src/main/news', () => ({
  getCachedNews: () => cachedNewsMock()
}))

import {
  handlePing,
  isAllowedExternalUrl,
  handleOpenExternal,
  handleGetSettings,
  handleSetSettings,
  handleGetNews,
  handleLaunchGame,
  makeHandleStartInstallOrUpdate,
  handleVerifyInstall,
  makeHandleRepairInstall,
  handleUninstallGame,
  handleGetDWProtonStatus,
  makeHandleRedownloadDWProton,
  handleGetSikarugirStatus,
  handlePauseInstallOrUpdate,
  handleGetLogFilePath,
  handleShowLogFileInFolder,
  handleShowInstallDirInFolder,
  handleClearDownloadCache,
  registerGameIpcHandlers
} from '../../src/main/ipc'
import { ipcMain } from 'electron'
import {
  readSettings,
  writeSettings,
  DEFAULT_SETTINGS,
  getCachedWindowCloseBehavior,
  setCachedWindowCloseBehavior
} from '../../src/main/settings'

describe('handlePing', () => {
  it('returns pong', async () => {
    expect(await handlePing()).toBe('pong')
  })
})

describe('isAllowedExternalUrl', () => {
  it('allows an https cso-rse.my.id URL', () => {
    expect(isAllowedExternalUrl('https://cso-rse.my.id/news/some-article')).toBe(true)
  })

  it('allows an http cso-rse.my.id URL', () => {
    expect(isAllowedExternalUrl('http://cso-rse.my.id/news/some-article')).toBe(true)
  })

  it('rejects a file: URL', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects a javascript: URL', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects a different https host', () => {
    expect(isAllowedExternalUrl('https://evil.example.com/phish')).toBe(false)
  })

  it('allows an https tako.id URL (donate button)', () => {
    expect(isAllowedExternalUrl('https://tako.id/csorseid')).toBe(true)
  })

  it('rejects an unparseable string', () => {
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })
})

describe('handleOpenExternal', () => {
  it('invokes the injected openFn for an allowed URL', () => {
    const opened: string[] = []
    handleOpenExternal('https://cso-rse.my.id/news/some-article', (u) => opened.push(u))
    expect(opened).toEqual(['https://cso-rse.my.id/news/some-article'])
  })

  it('does not invoke the injected openFn for a disallowed URL', () => {
    const opened: string[] = []
    handleOpenExternal('file:///etc/passwd', (u) => opened.push(u))
    expect(opened).toEqual([])
  })
})

describe('handleGetSettings / handleSetSettings', () => {
  let userDataDir: string

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'csore-settings-test-'))
    getPathMock.mockImplementation((name: string) => (name === 'userData' ? userDataDir : `/mock/${name}`))
  })

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('reads settings from the real app userData path -- the handler takes no directory argument', async () => {
    await writeSettings(userDataDir, { ...DEFAULT_SETTINGS, lang: 'na_id' })
    const result = await handleGetSettings()
    expect(result.lang).toBe('na_id')
  })

  it('writes settings to the real app userData path -- the handler takes no directory argument', async () => {
    await handleSetSettings(undefined, { ...DEFAULT_SETTINGS, classicUi: true })
    const onDisk = await readSettings(userDataDir)
    expect(onDisk.classicUi).toBe(true)
  })

  it('keeps the cached windowCloseBehavior in sync with every settings write', async () => {
    setCachedWindowCloseBehavior('exit')
    await handleSetSettings(undefined, { ...DEFAULT_SETTINGS, windowCloseBehavior: 'minimize_to_tray' })
    expect(getCachedWindowCloseBehavior()).toBe('minimize_to_tray')

    await handleSetSettings(undefined, { ...DEFAULT_SETTINGS, windowCloseBehavior: 'exit' })
    expect(getCachedWindowCloseBehavior()).toBe('exit')
  })
})

describe('handleChooseInstallFolder', () => {
  it('gives a Windows-specific explanation for a Program Files / Windows-dir path', async () => {
    const { handleChooseInstallFolder } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['C:\\Program Files\\rse']
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await expect(handleChooseInstallFolder()).rejects.toThrow(/Windows blocks regular apps/i)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('uses the generic message for an unwritable folder that is not a protected Windows path', async () => {
    const { handleChooseInstallFolder } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    const missingDir = join(tmpdir(), `csore-does-not-exist-${Date.now()}`)
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [missingDir]
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)

    await expect(handleChooseInstallFolder()).rejects.toThrow(/is not writable\. Choose a different folder\./i)
  })
})

describe('handleLaunchGame', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-${Date.now()}`)
    await expect(handleLaunchGame(undefined, neverApprovedDir)).rejects.toThrow(/not an approved install directory/i)
  })

  describe('pre-launch verification', () => {
    let dir: string
    let originalFetch: typeof fetch

    beforeEach(async () => {
      const { dialog } = await import('electron')
      const { handleChooseInstallFolder } = await import('../../src/main/ipc')
      dir = await mkdtemp(join(tmpdir(), 'csore-launch-verify-'))
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: [dir]
      } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
      await handleChooseInstallFolder()

      originalFetch = global.fetch
      global.fetch = (async () => {
        throw new Error('network disabled in test')
      }) as unknown as typeof fetch
    })

    afterEach(async () => {
      global.fetch = originalFetch
      await rm(dir, { recursive: true, force: true })
    })

    it('proceeds to launch (does not block) when every recorded file matches', async () => {
      const { writeInstallState } = await import('../../src/main/installState')
      await writeInstallState(dir, { version: '1.0.0', installDir: dir, files: [] })

      await expect(handleLaunchGame(undefined, dir)).rejects.toThrow()
    })

    it("returns launched: false and does not launch when a recorded file is missing", async () => {
      const { writeInstallState } = await import('../../src/main/installState')
      await writeInstallState(dir, {
        version: '1.0.0',
        installDir: dir,
        files: [{ path: 'Bin/cstrike-online.exe', md5: 'deadbeef' }]
      })

      const result = await handleLaunchGame(undefined, dir)
      expect(result.launched).toBe(false)
      expect(result.verifyResult?.ok).toBe(false)
      expect(result.verifyResult?.missingFiles).toEqual(['Bin/cstrike-online.exe'])
    })
  })
})

describe('handleShowInstallDirInFolder', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-reveal-${Date.now()}`)
    await expect(handleShowInstallDirInFolder(undefined, neverApprovedDir)).rejects.toThrow(
      /not an approved install directory/i
    )
  })

  it('invokes the injected showFn with the approved install dir', async () => {
    const { handleChooseInstallFolder } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    const dir = await mkdtemp(join(tmpdir(), 'csore-reveal-test-'))
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [dir]
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
    await handleChooseInstallFolder()

    const calls: string[] = []
    await handleShowInstallDirInFolder(undefined, dir, (p) => calls.push(p))
    expect(calls).toEqual([dir])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('handleGetNews', () => {
  it('returns whatever news.ts currently has cached', async () => {
    const sample = [
      { id: 9, title: 'T', slug: 's', category: 'info', image: 'i.png', created_at: '2026-01-01T00:00:00Z' }
    ]
    cachedNewsMock.mockReturnValueOnce(sample)
    expect(await handleGetNews()).toEqual(sample)
  })

  it('returns an empty array when nothing has been cached yet', async () => {
    cachedNewsMock.mockReturnValueOnce([])
    expect(await handleGetNews()).toEqual([])
  })
})

describe('app:getPlatform handler', () => {
  it('registers a handler that returns process.platform', () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    registerGameIpcHandlers(fakeWin)

    const call = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === 'app:getPlatform')
    expect(call).toBeDefined()
    const handler = call?.[1] as () => string
    expect(handler()).toBe(process.platform)
  })
})

describe('makeHandleStartInstallOrUpdate', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    const handler = makeHandleStartInstallOrUpdate(fakeWin)
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-${Date.now()}`)
    await expect(handler(undefined, neverApprovedDir)).rejects.toThrow(/not an approved install directory/i)
  })
})

describe('handleVerifyInstall', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-verify-${Date.now()}`)
    await expect(handleVerifyInstall(undefined, neverApprovedDir)).rejects.toThrow(
      /not an approved install directory/i
    )
  })
})

describe('makeHandleRepairInstall', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    const handler = makeHandleRepairInstall(fakeWin)
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-repair-${Date.now()}`)
    await expect(handler(undefined, neverApprovedDir)).rejects.toThrow(/not an approved install directory/i)
  })
})

describe('handleUninstallGame', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-uninstall-${Date.now()}`)
    await expect(handleUninstallGame(undefined, neverApprovedDir)).rejects.toThrow(
      /not an approved install directory/i
    )
  })
})

describe('handleGetDWProtonStatus / handleGetSikarugirStatus (no installDir gate)', () => {
  it('handleGetDWProtonStatus returns a DWProtonStatus shape', async () => {
    const result = await handleGetDWProtonStatus()
    expect(result).toHaveProperty('installed')
    expect(result).toHaveProperty('version')
  })

  it('handleGetSikarugirStatus returns a SikarugirStatus shape', async () => {
    const result = await handleGetSikarugirStatus()
    expect(result).toHaveProperty('found')
    expect(result).toHaveProperty('wrapperPath')
  })
})

describe('new IPC channels are all registered', () => {
  it('registers game:verifyInstall, game:repairInstall, game:uninstall, game:getDWProtonStatus, game:redownloadDWProton, game:getSikarugirStatus', () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    registerGameIpcHandlers(fakeWin)

    const registeredChannels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)
    expect(registeredChannels).toEqual(
      expect.arrayContaining([
        'game:verifyInstall',
        'game:repairInstall',
        'game:uninstall',
        'game:getDWProtonStatus',
        'game:redownloadDWProton',
        'game:getSikarugirStatus'
      ])
    )
  })

  it('registers game:pauseInstallOrUpdate, game:getLogFilePath, game:showLogFileInFolder, game:clearDownloadCache', () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    registerGameIpcHandlers(fakeWin)

    const registeredChannels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel)
    expect(registeredChannels).toEqual(
      expect.arrayContaining([
        'game:pauseInstallOrUpdate',
        'game:getLogFilePath',
        'game:showLogFileInFolder',
        'game:showInstallDirInFolder',
        'game:clearDownloadCache'
      ])
    )
  })
})

describe('handlePauseInstallOrUpdate', () => {
  it('resolves without throwing even when nothing is currently running', async () => {
    await expect(handlePauseInstallOrUpdate()).resolves.toBeUndefined()
  })
})

describe('handleGetLogFilePath', () => {
  it('returns logger.ts logFilePath()', async () => {
    getPathMock.mockImplementation((name: string) => `/mock/${name}`)
    const { logFilePath } = await import('../../src/main/logger')
    expect(await handleGetLogFilePath()).toBe(logFilePath())
  })
})

describe('handleShowLogFileInFolder', () => {
  it('invokes the injected showFn with the log file path', async () => {
    const { logFilePath } = await import('../../src/main/logger')
    const calls: string[] = []
    handleShowLogFileInFolder((p) => calls.push(p))
    expect(calls).toEqual([logFilePath()])
  })
})

describe('handleClearDownloadCache', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-clear-${Date.now()}`)
    await expect(handleClearDownloadCache(undefined, neverApprovedDir)).rejects.toThrow(
      /not an approved install directory/i
    )
  })

  it('resolves without throwing when nothing is there to clear', async () => {
    const { handleChooseInstallFolder } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    const dir = await mkdtemp(join(tmpdir(), 'csore-clear-cache-test-'))
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [dir]
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
    await handleChooseInstallFolder()

    await expect(handleClearDownloadCache(undefined, dir)).resolves.toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it('actually deletes the leftover .csore_download_tmp staging folder when present', async () => {
    const { handleChooseInstallFolder } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    const dir = await mkdtemp(join(tmpdir(), 'csore-clear-cache-test-'))
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [dir]
    } as Awaited<ReturnType<typeof dialog.showOpenDialog>>)
    await handleChooseInstallFolder()

    const { mkdir, writeFile, access } = await import('fs/promises')
    const stagingDir = join(dir, '.csore_download_tmp')
    await mkdir(join(stagingDir, 'parts'), { recursive: true })
    await writeFile(join(stagingDir, 'parts', 'part-0'), 'leftover')
    await writeFile(join(stagingDir, 'download.zip'), 'leftover zip')

    await handleClearDownloadCache(undefined, dir)

    await expect(access(stagingDir)).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('makeHandleRedownloadDWProton', () => {
  it('returns a handler function wired to push progress via webContents.send', () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    const handler = makeHandleRedownloadDWProton(fakeWin)
    expect(typeof handler).toBe('function')
  })
})

describe('Sikarugir setup link', () => {
  it('allows the official guide without opening arbitrary GitHub repositories', () => {
    expect(isAllowedExternalUrl('https://github.com/Sikarugir-App/Sikarugir')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/other/repository')).toBe(false)
    expect(isAllowedExternalUrl('https://github.com/Sikarugir-App/Sikarugir/evil')).toBe(false)
  })
})

describe('moving an installation through the native picker', () => {
  let root: string
  let source: string
  let destination: string

  beforeEach(async () => {
    const { mkdir } = await import('fs/promises')
    const { writeInstallState } = await import('../../src/main/installState')
    root = await realpath(await mkdtemp(join(tmpdir(), 'csore-move-ipc-')))
    source = join(root, 'source')
    destination = join(root, 'destination')
    await mkdir(source)
    await mkdir(destination)
    await writeInstallState(source, { version: 'fixture', installDir: source, files: [] })
    getPathMock.mockImplementation(() => root)
    const { dialog } = await import('electron')
    vi.mocked(dialog.showOpenDialog).mockReset()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses to open the move picker while a game is running', async () => {
    const { makeHandleMoveInstallation } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    await expect(makeHandleMoveInstallation(() => null, () => true)(null, source)).rejects.toThrow(/Close the game/)
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('rechecks game state after the picker closes', async () => {
    const { makeHandleMoveInstallation } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [destination] })
    const gameBusy = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    await expect(makeHandleMoveInstallation(() => null, gameBusy)(null, source)).rejects.toThrow(/Close the game/)
    const { readInstallState } = await import('../../src/main/installState')
    expect((await readInstallState(source))?.installDir).toBe(source)
  })

  it('leaves the installation unchanged when the picker is canceled', async () => {
    const { makeHandleMoveInstallation } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await makeHandleMoveInstallation(() => null, () => false)(null, source)).toBeNull()
    const { readInstallState } = await import('../../src/main/installState')
    expect((await readInstallState(source))?.installDir).toBe(source)
  })

  it('uses the native destination and persists the moved installation location', async () => {
    const { makeHandleMoveInstallation } = await import('../../src/main/ipc')
    const { dialog } = await import('electron')
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [destination] })
    expect(await makeHandleMoveInstallation(() => null, () => false)(null, source)).toEqual({ installDir: destination })
    const { getSelectedInstallDir } = await import('../../src/main/gameManager')
    expect(await getSelectedInstallDir()).toBe(destination)
    const { readInstallState } = await import('../../src/main/installState')
    expect((await readInstallState(destination))?.installDir).toBe(destination)
    expect(await readInstallState(source)).toBeNull()
  })
})

it('enforces the latest-version requirement on registered game actions in the main process', async () => {
  const { app, ipcMain } = await import('electron')
  const { registerGameIpcHandlers } = await import('../../src/main/ipc')
  const { setLauncherVersionStatus } = await import('../../src/main/launcherVersionGate')
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
  try {
    setLauncherVersionStatus('required')
    registerGameIpcHandlers(() => null)
    for (const channel of ['game:launch', 'game:startInstallOrUpdate', 'game:repairInstall', 'game:moveInstallation', 'game:setSettings']) {
      const registration = vi.mocked(ipcMain.handle).mock.calls.filter(([name]) => name === channel).at(-1)
      expect(registration).toBeDefined()
      expect(() => registration![1]({} as Electron.IpcMainInvokeEvent, '/unapproved')).toThrow(/latest version/)
    }
  } finally {
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true })
    setLauncherVersionStatus('checking')
  }
})
