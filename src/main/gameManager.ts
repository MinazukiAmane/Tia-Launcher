import { moveInstallDirectory, type MoveProgress, type MoveResult } from './moveInstallation'

import { app } from 'electron'
import { join, dirname, sep } from 'path'
import { writeFile, unlink, mkdir, rm, readFile, readdir, rename, realpath } from 'fs/promises'
import { createHash } from 'crypto'
import {
  readInstallState,
  writeInstallState,
  mergeManifestEntries,
  readPendingAudioPatch,
  writePendingAudioPatch,
  clearPendingAudioPatch,
  type InstallState,
  type InstalledFileEntry,
  type PendingAudioPatch
} from './installState'
import { fetchLauncherInfo } from './launcherApi'
import type { VersionBlock } from './launcherApi'
import { fetchVersionManifest, findVersionBlock, verifyAgainstManifest } from './manifestVerify'
import { decideAction, reassembleParts, downloadPartWithRetry } from './installManager'
import { resolveWithinRoot } from './pathSafety'
import { DownloadPausedError } from './downloader'
import { readManifest, applyPatch, PatchVerificationError } from './patcher'
import { extractZip } from './zipExtract'
import { readFreshGameCheckpoint, writeFreshGameCheckpoint, clearFreshGameCheckpoint } from './freshInstallCheckpoint'
import { bspatch } from './bsdiffAdapter'
import { readSettings, buildGameLaunchArgs } from './settings'
import { findGameExecutable, launchWindows } from './launcher/windows'
import { logInfo, logError } from './logger'
import {
  launchLinux,
  fetchLatestDWProtonRelease,
  dwprotonInstallDir,
  isDWProtonInstalled,
  extractDWProtonTarball,
  verifyTarballSha512,
  type DWProtonRelease
} from './launcher/linux'
import { launchMacOS, findSikarugirWrapper, SikarugirNotFoundError } from './launcher/macos'

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

async function runWindowsLaunch(installDir: string, args: string[], launchCommand?: string | null): Promise<void> {
  const exePath = await findGameExecutable(installDir)
  await launchWindows(exePath, args, launchCommand)
}

let dwprotonEnsurePromise: Promise<string> | null = null

async function downloadAndInstallDWProton(
  baseDir: string,
  release: DWProtonRelease,
  onProgress?: (update: ProgressUpdate) => void
): Promise<void> {
  await mkdir(baseDir, { recursive: true })

  const tarballPath = join(baseDir, `${release.tagName}.tar.xz`)
  try {
    const res = await fetch(release.downloadUrl)
    if (!res.ok || !res.body) throw new Error(`DWProton download failed: HTTP ${res.status}`)
    const { createWriteStream } = await import('fs')
    const { pipeline } = await import('stream/promises')
    const { Readable } = await import('stream')
    await pipeline(
      Readable.fromWeb(res.body as import('stream/web').ReadableStream),
      createWriteStream(tarballPath)
    )
    onProgress?.({ phase: 'downloading', processed: 1, total: 1 })
    await verifyTarballSha512(tarballPath, release.sha512sumUrl)
    await extractDWProtonTarball(tarballPath, dwprotonInstallDir(baseDir, release.tagName))
    onProgress?.({ phase: 'extracting', processed: 1, total: 1 })
  } finally {
    // Don't leave the downloaded tarball on disk once we're done with it
    // (success or failure).
    await rm(tarballPath, { force: true })
  }
}

// Find a complete DWProton installation.
async function findAnyInstalledDWProtonTag(baseDir: string): Promise<string | null> {
  const baseProtonDir = join(baseDir, 'proton')
  let existingTags: string[] = []
  try {
    existingTags = (await readdir(baseProtonDir)).filter(Boolean)
  } catch {
    existingTags = []
  }
  for (const tag of existingTags) {
    if (await isDWProtonInstalled(baseDir, tag)) return tag
  }
  return null
}

async function ensureDWProtonInstalled(baseDir: string): Promise<string> {
  if (dwprotonEnsurePromise) return dwprotonEnsurePromise

  dwprotonEnsurePromise = (async (): Promise<string> => {
    let release: DWProtonRelease | undefined
    try {
      release = await fetchLatestDWProtonRelease()
    } catch (err) {
      const existingTag = await findAnyInstalledDWProtonTag(baseDir)
      if (existingTag) return existingTag
      throw err
    }

    if (await isDWProtonInstalled(baseDir, release.tagName)) return release.tagName

    await downloadAndInstallDWProton(baseDir, release)

    return release.tagName
  })()

  try {
    return await dwprotonEnsurePromise
  } finally {
    dwprotonEnsurePromise = null
  }
}

export interface DWProtonStatus {
  installed: boolean
  version: string | null
}

// Report the installed DWProton tag.
export async function getDWProtonStatus(): Promise<DWProtonStatus> {
  const baseDir = join(app.getPath('userData'), 'runtimes')
  const tag = await findAnyInstalledDWProtonTag(baseDir)
  return { installed: tag !== null, version: tag }
}

export async function redownloadDWProton(onProgress?: (update: ProgressUpdate) => void): Promise<void> {
  const baseDir = join(app.getPath('userData'), 'runtimes')
  dwprotonEnsurePromise = (async (): Promise<string> => {
    const release = await fetchLatestDWProtonRelease()
    await downloadAndInstallDWProton(baseDir, release, onProgress)
    return release.tagName
  })()
  try {
    await dwprotonEnsurePromise
  } finally {
    dwprotonEnsurePromise = null
  }
}

async function runLinuxLaunch(installDir: string, args: string[], launchCommand?: string | null): Promise<void> {
  const exePath = await findGameExecutable(installDir) // Bin/ layout is the same across platforms; the exe itself differs, see Task 9/10's open assumption
  const baseDir = join(app.getPath('userData'), 'runtimes')
  const tagName = await ensureDWProtonInstalled(baseDir)
  const compatDataDir = join(baseDir, 'prefix')
  await launchLinux(dwprotonInstallDir(baseDir, tagName), compatDataDir, exePath, args, launchCommand)
}

async function runMacLaunch(installDir: string, args: string[], launchCommand?: string | null): Promise<void> {
  const exePath = await findGameExecutable(installDir)
  const wrapper = await findSikarugirWrapper(app.getPath('userData'))
  if (!wrapper) throw new SikarugirNotFoundError()
  await launchMacOS(wrapper.wrapperPath, exePath, args, launchCommand)
}

export interface SikarugirStatus {
  found: boolean
  wrapperPath: string | null
}

// Settings and Play resolve the same saved or explicitly named wrapper.
export async function getSikarugirStatus(): Promise<SikarugirStatus> {
  const wrapper = await findSikarugirWrapper(app.getPath('userData'))
  return { found: wrapper !== null, wrapperPath: wrapper?.wrapperPath ?? null }
}

let approvedInstallDir: string | null = null

const APPROVED_INSTALL_DIR_FILENAME = 'approved-install-dir.json'

function approvedInstallDirFilePath(): string {
  return join(app.getPath('userData'), APPROVED_INSTALL_DIR_FILENAME)
}

async function readPersistedApprovedInstallDir(): Promise<string | null> {
  try {
    const raw = await readFile(approvedInstallDirFilePath(), 'utf-8')
    const data = JSON.parse(raw) as { installDir?: unknown }
    return typeof data.installDir === 'string' ? data.installDir : null
  } catch {

    return null
  }
}

export async function setApprovedInstallDir(dir: string): Promise<void> {
  approvedInstallDir = dir
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(approvedInstallDirFilePath(), JSON.stringify({ installDir: dir }), 'utf-8')
  } catch {
    // Keep session approval if persisting the selected folder fails.
  }
}

export async function getSelectedInstallDir(): Promise<string | null> {
  return approvedInstallDir ?? await readPersistedApprovedInstallDir()
}

export function getApprovedInstallDir(): string | null {
  return approvedInstallDir
}

// Clear persisted approval when removing an installation.
async function clearApprovedInstallDir(): Promise<void> {
  approvedInstallDir = null
  await rm(approvedInstallDirFilePath(), { force: true })
}

export async function isApprovedInstallDir(installDir: string): Promise<boolean> {
  if (installDir === approvedInstallDir) return true
  if (installDir === (await readPersistedApprovedInstallDir())) return true
  return (await readInstallState(installDir)) !== null
}

export function selectLaunchFn(
  platform: NodeJS.Platform
): (installDir: string, args: string[], launchCommand?: string | null) => Promise<void> {
  if (platform === 'win32') return runWindowsLaunch
  if (platform === 'linux') return runLinuxLaunch
  if (platform === 'darwin') return runMacLaunch
  throw new Error(`unsupported platform: ${platform}`)
}

export async function launchGame(installDir: string): Promise<void> {
  const settings = await readSettings(app.getPath('userData'))
  const args = buildGameLaunchArgs(settings)
  const launch = selectLaunchFn(process.platform)
  await launch(installDir, args, settings.launchCommand)
}

async function resolveMaxBytesPerSecond(): Promise<number | undefined> {
  const settings = await readSettings(app.getPath('userData'))
  if (!settings.downloadSpeedLimitKbps || settings.downloadSpeedLimitKbps <= 0) return undefined
  return settings.downloadSpeedLimitKbps * 1024
}

export interface ProgressUpdate {
  phase:
    | 'downloading'
    | 'assembling'
    | 'applying_patch'
    | 'extracting'
    | 'downloading_audio'
    | 'assembling_audio'
    | 'extracting_audio'
  processed: number
  total: number
}

function mergeFileLists(base: InstalledFileEntry[], overlay: InstalledFileEntry[]): InstalledFileEntry[] {
  const byPath = new Map<string, InstalledFileEntry>()
  for (const file of base) byPath.set(file.path, file)
  for (const file of overlay) byPath.set(file.path, file)
  return [...byPath.values()]
}

let operationInProgress = false

export function isOperationInProgress(): boolean {
  return operationInProgress
}

// Cancellation preserves downloaded parts for resume.
let currentOperationAbortController: AbortController | null = null

// Return whether an active operation was paused.
export function pauseCurrentOperation(): boolean {
  if (!currentOperationAbortController) return false
  currentOperationAbortController.abort()
  return true
}

async function doFreshInstall(
  target: VersionBlock,
  installDir: string,
  partsDir: string,
  zipPath: string,
  onProgress: (update: ProgressUpdate) => void,
  maxBytesPerSecond?: number,
  externalSignal?: AbortSignal
): Promise<void> {
  let gameFiles = await readFreshGameCheckpoint(installDir, target)
  if (!gameFiles) {
    await clearFreshGameCheckpoint(installDir)
    await reassembleParts(
      target.game_pkgs,
      zipPath,
      partsDir,
      (processed, total) => onProgress({ phase: 'downloading', processed, total }),
      maxBytesPerSecond,
      externalSignal,
      undefined,
      undefined,
      (processed, total) => onProgress({ phase: 'assembling', processed, total })
    )
    // The ZIP is fully written and all parts were verified.
    await rm(partsDir, { recursive: true, force: true })
    gameFiles = await extractZip(zipPath, installDir, (processed, total) =>
      onProgress({ phase: 'extracting', processed, total })
    )

    await writeFreshGameCheckpoint(installDir, target, gameFiles)
  }
  // Do not retain the game ZIP during the independent audio download.
  await rm(zipPath, { force: true })

  let audioFiles: InstalledFileEntry[] = []
  if (target.audio_pkgs && target.audio_pkgs.length > 0) {
    const audioZipPath = `${zipPath}.audio.zip`
    try {
      await reassembleParts(
        target.audio_pkgs,
        audioZipPath,
        partsDir,
        (processed, total) => onProgress({ phase: 'downloading_audio', processed, total }),
        maxBytesPerSecond,
        externalSignal,
        undefined,
        undefined,
        (processed, total) => onProgress({ phase: 'assembling_audio', processed, total })
      )
      await rm(partsDir, { recursive: true, force: true })
      audioFiles = await extractZip(audioZipPath, installDir, (processed, total) =>
        onProgress({ phase: 'extracting_audio', processed, total })
      )
    } finally {
      await rm(audioZipPath, { force: true })
    }
  }

  const files = mergeFileLists(gameFiles, audioFiles)
  const newState: InstallState = { version: target.version, installDir, files }
  await writeInstallState(installDir, newState)

  await clearPendingAudioPatch(installDir)
  await clearFreshGameCheckpoint(installDir)
  await rm(partsDir, { recursive: true, force: true })
}

async function applyAudioPatchContinuation(
  installDir: string,
  pending: PendingAudioPatch,
  baseFiles: InstalledFileEntry[],
  partsDir: string,
  zipPath: string,
  onProgress: (update: ProgressUpdate) => void,
  maxBytesPerSecond: number | undefined,
  externalSignal: AbortSignal,
  recoveryTarget?: VersionBlock
): Promise<void> {
  const audioZipPath = `${zipPath}.audio.zip`
  try {
    await reassembleParts(
      pending.audioPkgs,
      audioZipPath,
      partsDir,
      (processed, total) => onProgress({ phase: 'downloading_audio', processed, total }),
      maxBytesPerSecond,
      externalSignal
    )
    const audioManifest = await readManifest(audioZipPath)
    try {
      await applyPatch(installDir, audioZipPath, audioManifest, bspatch)
    } catch (err) {
      if (err instanceof PatchVerificationError && err.reasonCode === 'old_md5_mismatch' && recoveryTarget) {
        logInfo('applyAudioPatchContinuation: recovering via fresh install after audio-side old_md5_mismatch', {
          installDir
        })
        await doFreshInstall(recoveryTarget, installDir, partsDir, zipPath, onProgress, maxBytesPerSecond, externalSignal)
        return
      }
      throw err
    }
    const files = mergeManifestEntries(baseFiles, audioManifest.entries)
    const newState: InstallState = { version: pending.toVersion, installDir, files }
    await writeInstallState(installDir, newState)
    await clearPendingAudioPatch(installDir)
    onProgress({ phase: 'extracting_audio', processed: 1, total: 1 })

    await rm(partsDir, { recursive: true, force: true })
  } finally {
    await rm(audioZipPath, { force: true })
  }
}

export interface InstallOperationResult {
  status: 'completed' | 'paused'
}

export async function performInstallOrUpdate(
  installDir: string,
  onProgress: (update: ProgressUpdate) => void
): Promise<InstallOperationResult> {
  if (operationInProgress) {
    throw new Error('another operation (install/update/repair/uninstall) is already in progress')
  }
  operationInProgress = true
  const abortController = new AbortController()
  currentOperationAbortController = abortController
  const signal = abortController.signal
  logInfo('performInstallOrUpdate: starting', { installDir })
  try {
    const info = await fetchLauncherInfo(API_BASE_URL, GAME_BIZ)
    const state = await readInstallState(installDir)
    if (state?.needsRepair) throw new Error('Verify or repair the imported game files before updating. A full installation is not needed.')

    const maxBytesPerSecond = await resolveMaxBytesPerSecond()

    const downloadTmpDir = join(installDir, '.csore_download_tmp')
    const partsDir = join(downloadTmpDir, 'parts')
    const zipPath = join(downloadTmpDir, 'download.zip')

    const pendingAudio = await readPendingAudioPatch(installDir)
    const action = decideAction(info, state, pendingAudio)

    if (pendingAudio && action.kind !== 'resume_audio_patch') {
      await clearPendingAudioPatch(installDir)
    }

    if (action.kind === 'resume_audio_patch') {
      try {
        await applyAudioPatchContinuation(
          installDir,
          action.pending,

          state!.files,
          partsDir,
          zipPath,
          onProgress,
          maxBytesPerSecond,
          signal,
          info.main.major ?? undefined
        )
        logInfo('performInstallOrUpdate: resumed audio-only patch succeeded', {
          installDir,
          version: action.pending.toVersion
        })
        return { status: 'completed' }
      } finally {
        await rm(zipPath, { force: true })
      }
    }

    if (action.kind === 'up_to_date') {
      logInfo('performInstallOrUpdate: already up to date', { installDir })
      return { status: 'completed' }
    }

    try {
      if (action.kind === 'fresh_install') {
        await doFreshInstall(action.target, installDir, partsDir, zipPath, onProgress, maxBytesPerSecond, signal)
        logInfo('performInstallOrUpdate: fresh install succeeded', { installDir, version: action.target.version })
        return { status: 'completed' }
      }

      // apply_patch
      await reassembleParts(
        action.patch.game_pkgs,
        zipPath,
        partsDir,
        (processed, total) => onProgress({ phase: 'downloading', processed, total }),
        maxBytesPerSecond,
        signal
      )
      const manifest = await readManifest(zipPath)
      try {
        await applyPatch(installDir, zipPath, manifest, bspatch)
      } catch (err) {
        if (err instanceof PatchVerificationError && err.reasonCode === 'old_md5_mismatch' && info.main.major) {
          await doFreshInstall(
            info.main.major,
            installDir,
            partsDir,
            zipPath,
            onProgress,
            maxBytesPerSecond,
            signal
          )
          logInfo('performInstallOrUpdate: recovered via fresh install after old_md5_mismatch', { installDir })
          return { status: 'completed' }
        }
        throw err
      }

      try {
        await rm(partsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
        await rm(zipPath, { force: true, maxRetries: 5, retryDelay: 50 })
      } catch (error) { logInfo('performInstallOrUpdate: patch download cleanup deferred', { error: (error as Error).message }) }
      const files = mergeManifestEntries(state?.files ?? [], manifest.entries)

      const gameSideState: InstallState = { version: action.toVersion, installDir, files }

      if (action.patch.audio_pkgs && action.patch.audio_pkgs.length > 0) {
        const pending: PendingAudioPatch = { toVersion: action.toVersion, audioPkgs: action.patch.audio_pkgs }

        await writePendingAudioPatch(installDir, pending)
        await writeInstallState(installDir, gameSideState)
        await applyAudioPatchContinuation(
          installDir,
          pending,
          gameSideState.files,
          partsDir,
          zipPath,
          onProgress,
          maxBytesPerSecond,
          signal,
          info.main.major ?? undefined
        )
      } else {
        await writeInstallState(installDir, gameSideState)
        await clearPendingAudioPatch(installDir)

        await rm(partsDir, { recursive: true, force: true })
      }

      logInfo('performInstallOrUpdate: patch applied successfully', { installDir, version: action.toVersion })
      return { status: 'completed' }
    } finally {
      await rm(zipPath, { force: true })
    }
  } catch (err) {
    if (err instanceof DownloadPausedError) {
      logInfo('performInstallOrUpdate: paused by player', { installDir })
      return { status: 'paused' }
    }
    logError('performInstallOrUpdate: failed', { installDir, error: (err as Error).message })
    throw err
  } finally {
    operationInProgress = false
    if (currentOperationAbortController === abortController) currentOperationAbortController = null
  }
}

export interface VerifyResult {
  ok: boolean
  corruptFiles: string[]
  missingFiles: string[]
}

// A manual check hashes every asset; Play reuses hashes of unchanged files.
export async function verifyInstall(installDir: string, quick = false): Promise<VerifyResult> {
  if (operationInProgress) throw new Error('Wait for the current operation to finish before verifying files.')
  operationInProgress = true
  try { return await verifyInstallContents(installDir, quick) }
  finally { operationInProgress = false }
}

async function verifyInstallContents(installDir: string, quick: boolean): Promise<VerifyResult> {
  const state = await readInstallState(installDir)
  if (!state) throw new Error(`no install found at "${installDir}" -- nothing to verify`)
  let manifest: Awaited<ReturnType<typeof fetchVersionManifest>> = null
  try {
    const info = await fetchLauncherInfo(API_BASE_URL, GAME_BIZ)
    manifest = await fetchVersionManifest(findVersionBlock(info, state.version)?.res_list_url)
  } catch (err) {
    logInfo('verifyInstall: server unavailable, using local state', { error: (err as Error).message })
  }
  const result = await verifyAgainstManifest(installDir,
    manifest && manifest.version === state.version ? manifest : { files: state.files },
    quick && !state.needsRepair)
  if (result.ok && state.needsRepair) {
    await writeInstallState(installDir, { ...state, installDir, needsRepair: false })
  }
  return result
}

// Repair only missing/corrupt assets from the published main manifest.
export async function repairInstall(
  installDir: string,
  onProgress: (update: ProgressUpdate) => void
): Promise<InstallOperationResult> {
  if (operationInProgress) {
    throw new Error('another operation (install/update/repair/uninstall) is already in progress')
  }
  operationInProgress = true
  const abortController = new AbortController()
  currentOperationAbortController = abortController
  logInfo('repairInstall: starting', { installDir })
  try {
    const info = await fetchLauncherInfo(API_BASE_URL, GAME_BIZ)
    if (!info.main.major) throw new Error('no published main version available for this game')

    const state = await readInstallState(installDir)
    if (!state) throw new Error('No installed game to repair. Install the game first.')
    if (!state.needsRepair && state.version !== info.main.major.version) throw new Error('Update the game before repairing files.')
    const manifest = await fetchVersionManifest(info.main.major.res_list_url)
    if (!manifest?.repair_supported || manifest.version !== info.main.major.version || !manifest.files.length) {
      throw new Error('Per-file repair is not available on the server yet. Regenerate the version manifest first.')
    }
    const result = await verifyAgainstManifest(installDir, manifest)
    const damaged = new Set([...result.corruptFiles, ...result.missingFiles])
    const files = manifest.files.filter(file => damaged.has(file.path))
    for (const file of files) {
      if (!file.url || !/^https?:$/.test(new URL(file.url).protocol) || !/^[a-f0-9]{32}$/i.test(file.md5) || !Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error('Server manifest has invalid repair metadata.')
      }
    }
    const maxBytesPerSecond = await resolveMaxBytesPerSecond()
    const staging = join(installDir, '.csore_download_tmp', 'repair')
    await mkdir(staging, { recursive: true })
    const total = files.reduce((sum, file) => sum + file.size, 0)
    let completed = 0
    for (const file of files) {
      const target = resolveWithinRoot(installDir, file.path, 'repair file', reason => { throw new Error(reason) })
      await mkdir(dirname(target), { recursive: true })
      const root = await realpath(installDir)
      const parent = await realpath(dirname(target))
      if (parent !== root && !parent.startsWith(root + sep)) throw new Error('Repair directory escapes the installation folder.')
      const staged = join(staging, createHash('sha256').update(file.path + file.md5).digest('hex'))
      await downloadPartWithRetry(
        { url: file.url!, md5: file.md5, size: file.size }, staged, maxBytesPerSecond,
        abortController.signal, { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 4000 }, 120_000,
        bytes => onProgress({ phase: 'downloading', processed: completed + bytes, total })
      )
      // The downloader verifies the complete MD5 before replacing the live file.
      await rename(staged, target)
      completed += file.size
      onProgress({ phase: 'downloading', processed: completed, total })
    }
    await writeInstallState(installDir, { version: manifest.version, installDir, files: manifest.files.map(({ path, md5 }) => ({ path, md5 })) })
    await clearPendingAudioPatch(installDir)
    await rm(staging, { recursive: true, force: true })
    logInfo('repairInstall: succeeded', { installDir, repairedFiles: files.length })
    return { status: 'completed' }
  } catch (err) {
    if (err instanceof DownloadPausedError) {
      logInfo('repairInstall: paused by player', { installDir })
      return { status: 'paused' }
    }
    logError('repairInstall: failed', { installDir, error: (err as Error).message })
    throw err
  } finally {
    operationInProgress = false
    if (currentOperationAbortController === abortController) currentOperationAbortController = null
  }
}

export async function moveInstallation(
  installDir: string, destination: string, onProgress: (progress: MoveProgress) => void
): Promise<MoveResult> {
  if (operationInProgress) throw new Error('Wait for the current operation to finish before moving the installation.')
  operationInProgress = true
  try {
    const result = await moveInstallDirectory(installDir, destination, onProgress)
    await setApprovedInstallDir(result.installDir)
    return result
  } finally {
    operationInProgress = false
  }
}

export async function uninstallGame(installDir: string): Promise<void> {
  if (operationInProgress) {
    throw new Error('another operation (install/update/repair) is already in progress -- cannot uninstall now')
  }
  operationInProgress = true
  try {
    await rm(installDir, { recursive: true, force: true })
    await clearApprovedInstallDir()
  } finally {
    operationInProgress = false
  }
}
