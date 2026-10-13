import { spawn } from 'child_process'
import { join, dirname, isAbsolute } from 'path'
import { access, stat, readFile, writeFile, mkdir, mkdtemp, rm } from 'fs/promises'
import { constants } from 'fs'
import { homedir, tmpdir } from 'os'
import { buildWrappedCommand, quoteShellArgUnix } from './launchCommand'
import { logInfo, logDebug, logError } from '../logger'

export interface SikarugirWrapper { wrapperPath: string; launcherPath: string; prefixPath: string }
export class SikarugirNotFoundError extends Error {
  constructor() {
    super('Create a Sikarugir wrapper with a Wine engine and select its .app in Settings before playing on macOS.')
    this.name = 'SikarugirNotFoundError'
  }
}

// Official Configure uses this compatibility entry point.
export async function inspectSikarugirWrapper(wrapperPath: string): Promise<SikarugirWrapper> {
  if (!isAbsolute(wrapperPath) || !wrapperPath.toLowerCase().endsWith('.app')) throw new SikarugirNotFoundError()
  const launcherPath = join(wrapperPath, 'Contents', 'MacOS', 'wineskinlauncher')
  const prefixPath = join(wrapperPath, 'Contents', 'SharedSupport', 'prefix')
  try {
    await access(launcherPath, constants.X_OK)
    if (!(await stat(launcherPath)).isFile()) throw new Error('invalid launcher')
    if (!(await stat(join(prefixPath, 'drive_c'))).isDirectory()) throw new Error('prefix not initialized')
    if (!(await stat(join(wrapperPath, 'Contents', 'SharedSupport', 'wine'))).isDirectory()) throw new Error('no engine')
  } catch { throw new SikarugirNotFoundError() }
  return { wrapperPath, launcherPath, prefixPath }
}

const selectionPath = (userDataDir: string): string => join(userDataDir, 'sikarugir-wrapper.json')
export async function saveSikarugirWrapper(userDataDir: string, wrapperPath: string): Promise<void> {
  await inspectSikarugirWrapper(wrapperPath)
  await mkdir(userDataDir, { recursive: true })
  await writeFile(selectionPath(userDataDir), JSON.stringify({ wrapperPath }), 'utf8')
}

export async function findSikarugirWrapper(userDataDir: string): Promise<SikarugirWrapper | null> {
  try {
    const saved = JSON.parse(await readFile(selectionPath(userDataDir), 'utf8')) as { wrapperPath?: unknown }
    // A stale selection must not silently switch to another wrapper.
    if (typeof saved.wrapperPath !== 'string') return null
    try { return await inspectSikarugirWrapper(saved.wrapperPath) } catch { return null }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  for (const base of [join(homedir(), 'Applications', 'Sikarugir'), '/Applications/Sikarugir']) {
    try { return await inspectSikarugirWrapper(join(base, 'Tia Launcher.app')) } catch { /* not installed here */ }
  }
  return null
}

function batchArg(value: string): string {
  if (/[\r\n\0"]/.test(value)) throw new Error('Unsupported quote or control character in macOS game path or argument.')
  return `"${value.replace(/%/g, '%%')}"`
}
export function buildSikarugirBatch(exePath: string, args: string[]): string {
  const windowsPath = (path: string): string => 'Z:' + path.replace(/\//g, '\\')
  return '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' +
    `cd /d ${batchArg(windowsPath(dirname(exePath)))}\r\n` +
    [windowsPath(exePath), ...args].map(batchArg).join(' ') + '\r\n'
}

export async function launchMacOS(wrapperPath: string, exePath: string, args: string[], launchCommand?: string | null): Promise<void> {
  const wrapper = await inspectSikarugirWrapper(wrapperPath)
  const batch = buildSikarugirBatch(exePath, args)
  const staging = await mkdtemp(join(tmpdir(), 'tia-sikarugir-'))
  const batchPath = join(staging, 'launch-game.bat')
  try {
    await writeFile(batchPath, batch, 'utf8')
    const command = [wrapper.launcherPath, 'WSS-installer', batchPath].map(quoteShellArgUnix).join(' ')
    const wrapped = buildWrappedCommand(launchCommand, command)
    logInfo('launchMacOS: launching through Sikarugir', { exePath, wrapperPath })
    if (wrapped) logDebug('launchMacOS: resolved launch command', { command: wrapped })
    await new Promise<void>((resolve, reject) => {
      const child = wrapped === null
        ? spawn(wrapper.launcherPath, ['WSS-installer', batchPath], { cwd: dirname(exePath), detached: true, stdio: 'ignore' })
        : spawn(wrapped, { cwd: dirname(exePath), detached: true, stdio: 'ignore', shell: true })
      child.once('error', reject)
      child.once('exit', () => { void rm(staging, { recursive: true, force: true }).catch(() => {}) })
      child.once('spawn', () => { child.unref(); resolve() })
    })
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    logError('launchMacOS: Sikarugir launch failed', { error: (err as Error).message })
    throw new Error(`Could not launch the game through Sikarugir: ${(err as Error).message}`)
  }
}
