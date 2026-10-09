
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dirname } from 'path'
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
    vi.doMock('child_process', () => ({ execFile: execFileMock }))

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
