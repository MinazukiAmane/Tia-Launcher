import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const getPathMock = vi.fn((name: string) => `/mock/${name}`)

vi.mock('electron', () => ({
  app: { getPath: (name: string) => getPathMock(name) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const cachedNewsMock = vi.fn(() => [] as import('./news').NewsItem[])
vi.mock('./news', () => ({
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
  handleGetWhiskyStatus,
  registerGameIpcHandlers
} from './ipc'
import { ipcMain } from 'electron'
import { readSettings, writeSettings, DEFAULT_SETTINGS } from './settings'

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
})

describe('handleLaunchGame', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-${Date.now()}`)
    await expect(handleLaunchGame(undefined, neverApprovedDir)).rejects.toThrow(/not an approved install directory/i)
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

describe('handleGetDWProtonStatus / handleGetWhiskyStatus (no installDir gate)', () => {
  it('handleGetDWProtonStatus returns a DWProtonStatus shape', async () => {
    const result = await handleGetDWProtonStatus()
    expect(result).toHaveProperty('installed')
    expect(result).toHaveProperty('version')
  })

  it('handleGetWhiskyStatus returns a WhiskyStatus shape', async () => {
    const result = await handleGetWhiskyStatus()
    expect(result).toHaveProperty('found')
    expect(result).toHaveProperty('bottlePath')
  })
})

describe('new IPC channels are all registered', () => {
  it('registers game:verifyInstall, game:repairInstall, game:uninstall, game:getDWProtonStatus, game:redownloadDWProton, game:getWhiskyStatus', () => {
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
        'game:getWhiskyStatus'
      ])
    )
  })
})

describe('makeHandleRedownloadDWProton', () => {
  it('returns a handler function wired to push progress via webContents.send', () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    const handler = makeHandleRedownloadDWProton(fakeWin)
    expect(typeof handler).toBe('function')
  })
})
