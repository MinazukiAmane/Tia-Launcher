import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { prepareCSORELaunch } from '../../../src/main/launcher/csoreLaunch'
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../../../src/main/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})
afterEach(() => vi.restoreAllMocks())
const fixture = (arch: string) => join(process.cwd(), 'tests/fixtures', `pe-${arch}.bin`)
const hostPath = (path: string) => process.platform === 'win32' ? path : path.slice(2).replace(/\\/g, '/')

describe('native CSO launch boundary', () => {
  it('rejects invalid and missing executables before preparing a runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tia-invalid-client-'))
    try {
      const path = join(root, 'client.exe'); await writeFile(path, 'invalid')
      await expect(prepareCSORELaunch(path, [])).rejects.toThrow('Could not initialize game launch')
      await expect(prepareCSORELaunch(join(root, 'missing.exe'), [])).rejects.toThrow('not found')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('selects matching runtimes and preserves client arguments', async () => {
    for (const arch of ['x86', 'x64']) {
      const session = await prepareCSORELaunch(fixture(arch), ['-lang', 'na_en', 'two words'])
      try {
        expect(session.executable).toBe(join(process.cwd(), `build/native/csore-start-${arch}.exe`))
        expect(session.args.slice(-3)).toEqual(['-lang', 'na_en', 'two words'])
      } finally { await session.cleanup() }
    }
  })
  it('requires explicit native acknowledgement and surfaces native validation failure', async () => {
    const session = await prepareCSORELaunch(fixture('x86'), [])
    try {
      await writeFile(hostPath(session.args[0]), 'error: Could not initialize client\n')
      await expect(session.ready()).rejects.toThrow('Could not initialize client')
      await writeFile(hostPath(session.args[0]), 'ready\n')
      await expect(session.ready()).resolves.toBeUndefined()
    } finally { await session.cleanup() }
  })
  it('tolerates status report cleanup locks after successful startup', async () => {
    const session = await prepareCSORELaunch(fixture('x86'), [])
    try {
      const report = hostPath(session.args[0]); await writeFile(report, 'ready\n')
      await session.ready(); expect(await readFile(report, 'utf8')).toBe('ready\n')
      vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('locked report'), { code: 'EBUSY' }))
      await expect(session.cleanup()).resolves.toBeUndefined()
    } finally { await session.cleanup() }
  })
})
