
import { app } from 'electron'
import { join } from 'path'
import { writeFile, unlink } from 'fs/promises'
import { readInstallState, writeInstallState, type InstallState } from './installState'
import { fetchLauncherInfo } from './launcherApi'
import { decideAction, reassembleParts } from './installManager'
import { readManifest, applyPatch } from './patcher'
import { bspatch } from './bsdiffAdapter'
import { readSettings, buildGameLaunchArgs } from './settings'
import { findGameExecutable, launchWindows } from './launcher/windows'
import {
  launchLinux,
  fetchLatestDWProtonRelease,
  dwprotonInstallDir,
  isDWProtonInstalled,
  extractDWProtonTarball
} from './launcher/linux'
import { launchMacOS, findWhiskyBottle, WhiskyNotFoundError } from './launcher/macos'

// Adjust to the real deployed adminapi base URL and this game's biz slug.
const API_BASE_URL = 'https://sg-csore-api.serenetia.com'
const GAME_BIZ = 'csore_global'

export async function checkDirWritable(dir: string): Promise<boolean> {
  const probePath = join(dir, `.csore-write-test-${Date.now()}`)
  try {
    await writeFile(probePath, '')
    await unlink(probePath)
    return true
  } catch {
    return false
  }
}

async function runWindowsLaunch(installDir: string, args: string[]): Promise<void> {
  const exePath = await findGameExecutable(installDir)
  launchWindows(exePath, args)
}

async function runLinuxLaunch(installDir: string, args: string[]): Promise<void> {
  const exePath = await findGameExecutable(installDir) // Bin/ layout is the same across platforms; the exe itself differs, see Task 9/10's open assumption
  const baseDir = join(app.getPath('userData'), 'runtimes')
  const release = await fetchLatestDWProtonRelease()
  if (!(await isDWProtonInstalled(baseDir, release.tagName))) {
    const tarballPath = join(baseDir, `${release.tagName}.tar.xz`)
    const res = await fetch(release.downloadUrl)
    if (!res.ok || !res.body) throw new Error(`DWProton download failed: HTTP ${res.status}`)
    const { createWriteStream } = await import('fs')
    const { pipeline } = await import('stream/promises')
    const { Readable } = await import('stream')
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(tarballPath))
    await extractDWProtonTarball(tarballPath, dwprotonInstallDir(baseDir, release.tagName))
  }
  const compatDataDir = join(baseDir, 'prefix')
  launchLinux(dwprotonInstallDir(baseDir, release.tagName), compatDataDir, exePath, args)
}

async function runMacLaunch(installDir: string, args: string[]): Promise<void> {
  const exePath = await findGameExecutable(installDir)
  const bottle = await findWhiskyBottle('csore-launcher')
  if (!bottle) throw new WhiskyNotFoundError()
  await launchMacOS(bottle, exePath, args)
}

export function selectLaunchFn(
  platform: NodeJS.Platform
): (installDir: string, args: string[]) => Promise<void> {
  if (platform === 'win32') return runWindowsLaunch
  if (platform === 'linux') return runLinuxLaunch
  if (platform === 'darwin') return runMacLaunch
  throw new Error(`unsupported platform: ${platform}`)
}

export async function launchGame(installDir: string): Promise<void> {
  const settings = await readSettings(app.getPath('userData'))
  const args = buildGameLaunchArgs(settings)
  const launch = selectLaunchFn(process.platform)
  await launch(installDir, args)
}

export interface ProgressUpdate {
  phase: 'downloading' | 'applying_patch' | 'extracting'
  processed: number
  total: number
}

export async function performInstallOrUpdate(
  installDir: string,
  onProgress: (update: ProgressUpdate) => void
): Promise<void> {
  const info = await fetchLauncherInfo(API_BASE_URL, GAME_BIZ)
  const state = await readInstallState(installDir)
  const action = decideAction(info, state)

  if (action.kind === 'up_to_date') return

  const partsDir = join(app.getPath('temp'), 'csore-launcher-parts')
  const zipPath = join(app.getPath('temp'), 'csore-launcher-download.zip')

  if (action.kind === 'fresh_install') {
    await reassembleParts(action.target.game_pkgs, zipPath, partsDir, (processed, total) =>
      onProgress({ phase: 'downloading', processed, total })
    )
    const { default: AdmZip } = await import('adm-zip')
    new AdmZip(zipPath).extractAllTo(installDir, true)
    const newState: InstallState = { version: action.target.version, installDir, files: [] }
    await writeInstallState(installDir, newState)
    return
  }

  // apply_patch
  await reassembleParts(action.patch.game_pkgs, zipPath, partsDir, (processed, total) =>
    onProgress({ phase: 'downloading', processed, total })
  )
  const manifest = readManifest(zipPath)
  await applyPatch(installDir, zipPath, manifest, bspatch)
  const newState: InstallState = { version: action.toVersion, installDir, files: [] }
  await writeInstallState(installDir, newState)
}
