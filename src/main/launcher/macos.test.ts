// Process/wrapper tests isolate native helper preparation.
vi.mock('./flagLaunch', () => ({
  prepareFlagLaunch: async (executable: string, args: string[]) => ({
    executable, args, ready: async () => {}, cleanup: async () => {}
  })
}))
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { EventEmitter } from 'events'
import * as childProcess from 'child_process'
vi.mock('child_process', () => ({ spawn: vi.fn() }))
import {
  launchMacOS, SikarugirNotFoundError, inspectSikarugirWrapper,
  saveSikarugirWrapper, findSikarugirWrapper, buildSikarugirBatch
} from './macos'
vi.mock('../logger', () => ({ logInfo: vi.fn(), logDebug: vi.fn(), logError: vi.fn() }))

let dir: string, wrapper: string
const children: EventEmitter[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'csore-sikarugir-test-'))
  wrapper = join(dir, 'Tia Launcher.app')
  for (const rel of ['Contents/MacOS', 'Contents/SharedSupport/prefix/drive_c', 'Contents/SharedSupport/wine']) {
    await mkdir(join(wrapper, rel), { recursive: true })
  }
  await writeFile(join(wrapper, 'Contents/MacOS/wineskinlauncher'), 'fixture', { mode: 0o755 })
})
afterEach(async () => {
  for (const child of children.splice(0)) child.emit('exit', 0)
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.clearAllMocks()
  await rm(dir, { recursive: true, force: true })
})

function mockSpawn(): typeof childProcess.spawn {
  return vi.mocked(childProcess.spawn).mockImplementation(() => {
    const child = new EventEmitter() as unknown as childProcess.ChildProcess
    child.unref = vi.fn().mockReturnValue(child)
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
}

describe('Sikarugir wrapper selection', () => {
  it('validates a wrapper, persists the selection, and rejects an uninitialized wrapper', async () => {
    const selected = await inspectSikarugirWrapper(wrapper)
    expect(selected.prefixPath).toBe(join(wrapper, 'Contents/SharedSupport/prefix'))
    await saveSikarugirWrapper(join(dir,'userdata'), wrapper)
    expect(await findSikarugirWrapper(join(dir,'userdata'))).toEqual(selected)
    await rm(join(wrapper,'Contents/SharedSupport/prefix/drive_c'), { recursive: true })
    expect(await findSikarugirWrapper(join(dir,'userdata'))).toBeNull()
    await expect(inspectSikarugirWrapper(wrapper)).rejects.toThrow(SikarugirNotFoundError)
  })
  it('does not replace a stale selection with a different wrapper', async () => {
    await writeFile(join(dir,'sikarugir-wrapper.json'), JSON.stringify({ wrapperPath: join(dir,'missing.app') }))
    expect(await findSikarugirWrapper(dir)).toBeNull()
  })
  it('gives actionable setup instructions for invalid selections', async () => {
    await expect(launchMacOS('/nonexistent.app','/game/client.exe',[])).rejects.toThrow(/Sikarugir/)
    expect(new SikarugirNotFoundError().message).toMatch(/select its .app/i)
  })
})

describe('Sikarugir launch', () => {
  it('passes a batch to the bundled launcher, resolves on spawn, and cleans up on exit', async () => {
    const spawn = vi.mocked(mockSpawn())
    const exe = join(dir,'Game Folder','client.exe')
    await launchMacOS(wrapper, exe, ['-lang','na_en'])
    const [command, args, options] = spawn.mock.calls[0]
    expect(command).toBe(join(wrapper,'Contents/MacOS/wineskinlauncher'))
    expect((args as string[])[0]).toBe('WSS-installer')
    expect((options as { cwd: string }).cwd).toBe(dirname(exe))
    const batch = (args as string[])[1]
    expect(await readFile(batch,'utf8')).toContain('"-lang" "na_en"')
    children[0].emit('exit',0)
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(access(batch)).rejects.toThrow()
  })
  it('preserves Launch Command around the wrapper invocation', async () => {
    const spawn = vi.mocked(mockSpawn())
    await launchMacOS(wrapper, join(dir,'client.exe'), [], 'MTL_HUD_ENABLED=1 %command%')
    expect(String(spawn.mock.calls[0][0])).toContain('MTL_HUD_ENABLED=1')
    expect(String(spawn.mock.calls[0][0])).toContain("'WSS-installer'")
    expect((spawn.mock.calls[0][1] as unknown as { shell: boolean }).shell).toBe(true)
  })
  it('rejects an OS spawn failure without reporting a successful launch', async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      const child = new EventEmitter() as childProcess.ChildProcess
      queueMicrotask(() => child.emit('error',new Error('spawn failed')))
      return child
    })
    await expect(launchMacOS(wrapper,join(dir,'client.exe'),[])).rejects.toThrow(/Sikarugir.*spawn failed/)
  })
  it('quotes game arguments, preserves literal percent signs and rejects command injection', () => {
    const batch = buildSikarugirBatch('/Games/100% Fun/client.exe',['-lang','na_en','a&b'])
    expect(batch).toContain('100%% Fun')
    expect(batch).toContain('"a&b"')
    expect(batch).toContain('DisableDelayedExpansion')
    expect(() => buildSikarugirBatch('/Games/client.exe',['bad\r\ncommand'])).toThrow()
    expect(() => buildSikarugirBatch('/Games/client.exe',['bad"command'])).toThrow()
  })
})
