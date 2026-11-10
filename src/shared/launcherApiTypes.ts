import type { LauncherLanguage } from './launcherLanguage'

export type ServerStatus = { status: 'online' | 'offline' | 'maintenance' | 'unknown' | 'custom'; checkedAt: string | null }

export interface Preferences {
  launcherLanguage?: LauncherLanguage
  backgroundMode: 'image' | 'video' | null
  confirmedInstallDir: string | null
}

export interface PkgEntry {
  url: string
  md5: string
  size: string
  decompressed_size: string
}

export interface AudioPkgEntry extends PkgEntry {
  language: string
}

export interface VersionBlock {
  version: string
  game_pkgs: PkgEntry[]
  audio_pkgs?: AudioPkgEntry[]
  res_list_url: string
}

export interface MainBlock {
  major: VersionBlock | null
  patches: VersionBlock[]
  required_client_version: string
}

export interface GamePackageEntry {
  game: { id: string; biz: string }
  launcher_update_required?: boolean
  pre_download?: { major: VersionBlock | null; patches: VersionBlock[]; required_client_version?: string }
  enable_base_pkg_predownload?: boolean
  main: MainBlock
}

export interface InstalledFileEntry {
  path: string
  md5: string
}

export interface InstallState {
  gameBiz?: string
  version: string
  installDir: string
  files: InstalledFileEntry[]
  // Imported files are a repair target until verified against server hashes.
  needsRepair?: boolean
}

export interface InstallStateResponse extends InstallState {
  pendingAudioPatch: boolean
}

export interface MoveResult {
  installDir: string
  warning?: string
}

export interface MoveProgress {
  phase: 'moving' | 'copying' | 'verifying'
  processed: number
  total: number
}

export interface Settings {
  lang: 'na_id' | 'na_en'
  classicUi: boolean
  alternateRenderer: boolean
  fpsLimit?: 144 | 165 | 240 | null

  downloadSpeedLimitKbps: number | null

  launchCommand: string | null
  // Troubleshooting logging defaults to off.
  troubleshootingMode: boolean
  // Preferred close-button behavior.
  windowCloseBehavior: 'minimize_to_tray' | 'exit'
  // Custom background filename; null selects the built-in image.
  customBackground: string | null
  customVideo?: string | null
}

export interface VerifyResult {
  ok: boolean
  corruptFiles: string[]
  missingFiles: string[]
}

export interface LaunchGameResult {
  launched: boolean

  verifyResult?: VerifyResult
}

export interface InstallOperationResult {
  status: 'completed' | 'paused'
}

export interface DWProtonStatus {
  installed: boolean
  version: string | null
}

export interface SikarugirStatus {
  found: boolean
  wrapperPath: string | null
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

export interface NewsItem {
  id: number
  title: string
  slug: string
  category: string
  image: string
  created_at: string
}

export interface UpdateAvailableInfo {
  version: string
  isInitialCheck: boolean
}

export interface UpdateDownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
  updatedAt: number
}

export type VersionStatus = 'checking' | 'current' | 'required' | 'failed'

export interface UpdateState {
  versionStatus: VersionStatus
  available: UpdateAvailableInfo | null
  progress: number | null
  downloaded: boolean
  downloading: boolean
  downloadProgress: UpdateDownloadProgress | null
  error: string | null
}

export type Platform = 'win32' | 'linux' | 'darwin'

export interface PredownloadStatus { version: string; totalBytes: number; ready: boolean; launcherUpdateRequired: boolean; requiredClientVersion: string }
