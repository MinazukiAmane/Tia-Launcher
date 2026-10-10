
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dirname } from 'path'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/mock/${name}` }
}))

import { launchMacOS, WhiskyNotFoundError } from './macos'

describe('launchMacOS', () => {
  it('wraps a wine invocation failure in a clear, actionable error message', async () => {

    await expect(launchMacOS('/nonexistent/prefix', '/nonexistent/game.exe', [])).rejects.toThrow(
      /Whisky/i
    )
  })
})

describe('launchMacOS argument/cwd construction', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('passes /unix before the path and sets cwd to the executable\'s directory', async () => {
    const execFileMock = vi.fn((_cmd, _args, _opts, cb) => {
      cb(null, '', '')
      return {} as never
    })
    vi.doMock('child_process', () => ({ execFile: execFileMock, exec: vi.fn() }))

    const { launchMacOS: launchMacOSMocked } = await import('./macos')
    const exePath = '/fake/InstallDir/Bin/cstrike-online.exe'
    await launchMacOSMocked('/fake/prefix', exePath, ['-foo'])

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = execFileMock.mock.calls[0]
    expect(cmd).toBe('wine')
    expect(args).toEqual(['start', '/unix', exePath, '-foo'])
    expect((opts as { cwd?: string }).cwd).toBe(dirname(exePath))

    vi.doUnmock('child_process')
  })
})

describe('WhiskyNotFoundError', () => {
  it('has a message pointing the player at manual installation', () => {
    const err = new WhiskyNotFoundError()
    expect(err.message).toMatch(/install whisky manually/i)
  })
})

describe('launchMacOS: Launch Command wrapper', () => {
  afterEach(() => {
    vi.doUnmock('child_process')
    vi.resetModules()
  })

  it('with no launchCommand, calls execFile in the exact same array-form shape as before (no regression)', async () => {
    vi.resetModules()
    const execFileMock = vi.fn((_cmd, _args, _opts, cb) => {
      cb(null, '', '')
      return {} as never
    })
    vi.doMock('child_process', () => ({ execFile: execFileMock, exec: vi.fn() }))

    const { launchMacOS: launchMacOSMocked } = await import('./macos')
    const exePath = '/fake/InstallDir/Bin/cstrike-online.exe'
    await launchMacOSMocked('/fake/prefix', exePath, ['-lang', 'na_en'], null)

    expect(execFileMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFileMock.mock.calls[0]
    expect(cmd).toBe('wine')
    expect(args).toEqual(['start', '/unix', exePath, '-lang', 'na_en'])
  })

  it('with a launchCommand containing %command%, wraps the FULL `wine start /unix ...` invocation via exec (shell)', async () => {
    vi.resetModules()
    const execMock = vi.fn((_cmd, _opts, cb) => {
      cb(null, '', '')
      return {} as never
    })
    vi.doMock('child_process', () => ({ execFile: vi.fn(), exec: execMock }))

    const { launchMacOS: launchMacOSMocked } = await import('./macos')
    const exePath = '/fake/InstallDir/Bin/cstrike-online.exe'
    await launchMacOSMocked('/fake/prefix', exePath, [], 'MTL_HUD_ENABLED=1 %command%')

    expect(execMock).toHaveBeenCalledTimes(1)
    const [cmd, opts] = execMock.mock.calls[0]
    expect(cmd).toBe(`MTL_HUD_ENABLED=1 'wine' 'start' '/unix' '${exePath}'`)
    expect((opts as { env: Record<string, string> }).env.WINEPREFIX).toBe('/fake/prefix')
  })
})
