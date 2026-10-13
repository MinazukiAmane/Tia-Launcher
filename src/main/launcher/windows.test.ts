// Process/wrapper tests isolate native helper preparation.
vi.mock('./flagLaunch', () => ({
  prepareFlagLaunch: async (executable: string, args: string[]) => ({
    executable, args, ready: async () => {}, cleanup: async () => {}
  })
}))

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/mock/${name}` }
}))

import { findGameExecutable, launchWindows } from './windows'

let tempDirs: string[] = []
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'csore-win-launcher-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
  tempDirs = []
})

describe('findGameExecutable', () => {
  it('resolves to Bin/cstrike-online.exe when it exists (matches the real production launcher)', async () => {
    const installDir = await makeTempDir()
    await mkdir(join(installDir, 'Bin'), { recursive: true })
    await writeFile(join(installDir, 'Bin', 'cstrike-online.exe'), 'fake exe bytes')

    const got = await findGameExecutable(installDir)
    expect(got).toBe(join(installDir, 'Bin', 'cstrike-online.exe'))
  })

  it('throws when the executable is missing (install is incomplete/corrupted)', async () => {
    const installDir = await makeTempDir()
    await expect(findGameExecutable(installDir)).rejects.toThrow()
  })
})

describe('launchWindows', () => {
  it('rejects with a clear message when the executable does not exist (ENOENT)', async () => {
    const installDir = await makeTempDir()
    const exePath = join(installDir, 'Bin', 'cstrike-online.exe')
    await expect(launchWindows(exePath, [])).rejects.toThrow(/not found/i)
  })

  it('resolves and runs the real executable with cwd set to its own directory', async () => {
    const installDir = await makeTempDir()
    const binDir = join(installDir, 'Bin')
    await mkdir(binDir, { recursive: true })

    const scriptPath = join(binDir, 'check-cwd.js')
    const outPath = join(binDir, 'cwd.txt')
    await writeFile(
      scriptPath,
      `require('fs').writeFileSync(${JSON.stringify(outPath)}, process.cwd())`
    )
    await launchWindows(process.execPath, [scriptPath])
    await new Promise((r) => setTimeout(r, 300))
    const { readFile } = await import('fs/promises')
    const cwdSeen = await readFile(outPath, 'utf-8')
    expect(cwdSeen.trim()).toBe(dirname(process.execPath))
  })
})

it('forwards bare IP and port options to a real child process', async () => {
  const dir = await makeTempDir()
  const output = join(dir, 'argv.json')
  const script = join(dir, 'argv.cjs')
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`)
  await launchWindows(process.execPath, [script, '-lang', 'na_en'], '-ip 84.247.156.34 -port 50600')
  const { readFile } = await import('fs/promises')
  await vi.waitFor(async () => {
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(['-lang', 'na_en', '-ip', '84.247.156.34', '-port', '50600'])
  })
})

describe('launchWindows: Launch Command wrapper' , () => {
  afterEach(() => {
    vi.doUnmock('child_process')
    vi.resetModules()
  })

  it('with no launchCommand, spawns in the exact same array-form shape as before (no regression)', async () => {
    vi.resetModules()
    const spawnCalls: unknown[][] = []
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn((...args: unknown[]) => {
          spawnCalls.push(args)
          const { EventEmitter } = require('events')
          const child = new EventEmitter()
          child.unref = () => {}
          setImmediate(() => child.emit('spawn'))
          return child
        })
      }
    })

    const { launchWindows: launchWindowsMocked } = await import('./windows')
    await launchWindowsMocked('C:\\Games\\Bin\\cstrike-online.exe', ['-lang', 'na_en'], null)

    expect(spawnCalls).toHaveLength(1)
    const [command, args, options] = spawnCalls[0] as [string, string[], { shell?: boolean }]
    expect(command).toBe('C:\\Games\\Bin\\cstrike-online.exe')
    expect(args).toEqual(['-lang', 'na_en'])
    expect(options.shell).toBeUndefined()
  })

  it('with a launchCommand containing %command%, substitutes the real quoted command and spawns via shell:true', async () => {
    vi.resetModules()
    const spawnCalls: unknown[][] = []
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn((...args: unknown[]) => {
          spawnCalls.push(args)
          const { EventEmitter } = require('events')
          const child = new EventEmitter()
          child.unref = () => {}
          setImmediate(() => child.emit('spawn'))
          return child
        })
      }
    })

    const { launchWindows: launchWindowsMocked } = await import('./windows')
    await launchWindowsMocked('C:\\Games\\Bin\\cstrike-online.exe', ['-lang', 'na_en'], 'echo before && %command%')

    expect(spawnCalls).toHaveLength(1)
    const [command, options] = spawnCalls[0] as [string, { shell?: boolean }]
    expect(command).toBe('echo before && "C:\\Games\\Bin\\cstrike-online.exe" "-lang" "na_en"')
    expect(options.shell).toBe(true)
  })

  it('with a launchCommand missing %command%, appends the real command at the end', async () => {
    vi.resetModules()
    const spawnCalls: unknown[][] = []
    vi.doMock('child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('child_process')>()
      return {
        ...actual,
        spawn: vi.fn((...args: unknown[]) => {
          spawnCalls.push(args)
          const { EventEmitter } = require('events')
          const child = new EventEmitter()
          child.unref = () => {}
          setImmediate(() => child.emit('spawn'))
          return child
        })
      }
    })

    const { launchWindows: launchWindowsMocked } = await import('./windows')
    await launchWindowsMocked('C:\\Games\\Bin\\cstrike-online.exe', [], 'prime-run')

    expect(spawnCalls).toHaveLength(1)
    const [command] = spawnCalls[0] as [string]
    expect(command).toBe('prime-run "C:\\Games\\Bin\\cstrike-online.exe"')
  })
})
