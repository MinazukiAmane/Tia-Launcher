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

import {
  handlePing,
  isAllowedExternalUrl,
  handleOpenExternal,
  handleGetSettings,
  handleSetSettings,
  handleLaunchGame,
  makeHandleStartInstallOrUpdate
} from './ipc'
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

describe('makeHandleStartInstallOrUpdate', () => {
  it('rejects an installDir that was never approved via chooseInstallFolder', async () => {
    const fakeWin = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as Electron.BrowserWindow
    const handler = makeHandleStartInstallOrUpdate(fakeWin)
    const neverApprovedDir = join(tmpdir(), `csore-unapproved-${Date.now()}`)
    await expect(handler(undefined, neverApprovedDir)).rejects.toThrow(/not an approved install directory/i)
  })
})
