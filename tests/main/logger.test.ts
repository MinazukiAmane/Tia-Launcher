import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mockUserDataDir = { current: '' }
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataDir.current
      return `/mock/${name}`
    }
  }
}))

// Imported after the mock so logger.ts's own `import { app } from 'electron'`
// resolves to the mock above.
import { logInfo, logError, logDebug, logFilePath, setTroubleshootingMode } from '../../src/main/logger'

let tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-logger-test-'))
  tempDirs.push(dir)
  return dir
}

beforeEach(() => {
  setTroubleshootingMode(false)
})

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('logFilePath', () => {
  it('resolves under userData/logs/launcher.log', async () => {
    mockUserDataDir.current = await makeTempDir()
    expect(logFilePath()).toBe(join(mockUserDataDir.current, 'logs', 'launcher.log'))
  })
})

describe('logInfo / logError', () => {
  it('logInfo actually writes the message to the log file', async () => {
    mockUserDataDir.current = await makeTempDir()
    logInfo('install started', { installDir: '/foo/bar' })
    const contents = await readFile(logFilePath(), 'utf-8')
    expect(contents).toContain('[INFO]')
    expect(contents).toContain('install started')
    expect(contents).toContain('/foo/bar')
  })

  it('logError actually writes the message to the log file, distinct from logInfo', async () => {
    mockUserDataDir.current = await makeTempDir()
    logError('install failed', { reason: 'network' })
    const contents = await readFile(logFilePath(), 'utf-8')
    expect(contents).toContain('[ERROR]')
    expect(contents).toContain('install failed')
    expect(contents).toContain('network')
  })

  it('appends multiple log calls rather than overwriting', async () => {
    mockUserDataDir.current = await makeTempDir()
    logInfo('first')
    logInfo('second')
    const contents = await readFile(logFilePath(), 'utf-8')
    expect(contents).toContain('first')
    expect(contents).toContain('second')
    expect(contents.split('\n').filter(Boolean)).toHaveLength(2)
  })
})

describe('log rotation', () => {
  it('rotates a pre-existing launcher.log to launcher.old.log instead of destroying it', async () => {
    const dir = await makeTempDir()
    mockUserDataDir.current = dir
    const logsDir = join(dir, 'logs')
    await mkdir(logsDir, { recursive: true })
    await writeFile(join(logsDir, 'launcher.log'), 'previous session content\n', 'utf-8')

    logInfo('fresh session started')

    const current = await readFile(logFilePath(), 'utf-8')
    expect(current).not.toContain('previous session content')
    expect(current).toContain('fresh session started')

    const old = await readFile(join(logsDir, 'launcher.old.log'), 'utf-8')
    expect(old).toBe('previous session content\n')
  })
})

describe('logDebug / troubleshooting mode', () => {
  it('is suppressed (writes nothing) when troubleshooting mode is off', async () => {
    mockUserDataDir.current = await makeTempDir()
    setTroubleshootingMode(false)
    logDebug('verbose detail')

    logInfo('marker')
    const contents = await readFile(logFilePath(), 'utf-8')
    expect(contents).not.toContain('verbose detail')
  })

  it('is written when troubleshooting mode is on', async () => {
    mockUserDataDir.current = await makeTempDir()
    setTroubleshootingMode(true)
    logDebug('verbose detail', { command: 'wine start /unix foo' })
    const contents = await readFile(logFilePath(), 'utf-8')
    expect(contents).toContain('[DEBUG]')
    expect(contents).toContain('verbose detail')
    expect(contents).toContain('wine start /unix foo')
  })
})
