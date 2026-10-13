import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { exportedFlagArchitecture, prepareFlagLaunch } from './flagLaunch'
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('../logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
const exec = promisify(execFile)
const fixture = (arch: string): string => join(process.cwd(), 'src/main/launcher/fixtures', `flags-fixture-${arch}.exe`)

describe('exported flags launch', () => {
  it('detects flags on both client architectures without a fixed RVA', async () => {
    for (const arch of ['x86', 'x64']) expect(exportedFlagArchitecture(await readFile(fixture(arch)))).toBe(arch)
    expect(exportedFlagArchitecture(Buffer.from('not a PE'))).toBeNull()
    const oldClient = await readFile(fixture('x86'))
    const name = oldClient.indexOf(Buffer.from('flags\0'))
    oldClient.write('other', name)
    expect(exportedFlagArchitecture(oldClient)).toBeNull()
  })
  it('rejects clients without flags instead of returning a direct launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csore-no-flags-'))
    try {
      const path = join(dir, 'old.exe')
      await writeFile(path, 'legacy fixture')
      await expect(prepareFlagLaunch(path, [])).rejects.toThrow(/Could not initialize game launch/)
      const client = await readFile(fixture('x86'))
      client.write('other', client.indexOf(Buffer.from('flags\0')))
      await writeFile(path, client)
      await expect(prepareFlagLaunch(path, ['-lang', 'na_en'])).rejects.toThrow(/Could not initialize game launch/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects a missing executable before preparing a helper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csore-missing-client-'))
    try { await expect(prepareFlagLaunch(join(dir, 'missing.exe'), [])).rejects.toThrow(/not found/) }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('always selects a helper for a supported client and preserves arguments', async () => {
    const launch = await prepareFlagLaunch(fixture('x86'), ['-lang', 'na_en'])
    try {
      expect(launch.executable).toBe(join(process.cwd(), 'build/native/flag-launch-x86.exe'))
      expect(launch.args.slice(-2)).toEqual(['-lang', 'na_en'])
    } finally { await launch.cleanup() }
  })
  it.skipIf(process.platform !== 'win32')('sets flags before the first client instruction, preserving IP/port and quoted arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csore-flags-native-'))
    try {
      for (const arch of ['x86', 'x64']) {
        const output = join(dir, `result-${arch}.txt`)
        const launch = await prepareFlagLaunch(fixture(arch), [output, '-ip', '192.0.2.1', '-port', '50600', 'two words', 'ends\\'])
        try {
          await exec(launch.executable, launch.args, { timeout: 15_000 })
          await launch.ready()
          expect(await readFile(output, 'utf8')).toBe('flags=1\narg=-ip\narg=192.0.2.1\narg=-port\narg=50600\narg=two words\narg=ends\\\n')
        } finally { await launch.cleanup() }
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

it.skipIf(process.platform !== 'win32')('refuses a missing export without starting a client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csore-flags-refuse-'))
  try {
    const client = await readFile(fixture('x86'))
    client.write('other', client.indexOf(Buffer.from('flags\0')))
    const path = join(dir, 'no-flags.exe')
    const report = join(dir, 'status.txt')
    const output = join(dir, 'client-ran.txt')
    await writeFile(path, client)
    await expect(exec(join(process.cwd(), 'build/native/flag-launch-x86.exe'), [report, path, output], { timeout: 15_000 })).rejects.toThrow()
    expect(await readFile(report, 'utf8')).toContain('error: Find exported flags')
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
