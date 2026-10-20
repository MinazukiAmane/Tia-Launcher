
import { migrateRecord, writeRecords } from './localDatabase'
import { join } from 'path'
import { isValidBackgroundName } from './background'

export const MIN_DOWNLOAD_SPEED_LIMIT_KBPS = 100
export const MAX_DOWNLOAD_SPEED_LIMIT_KBPS = 20480

export const MAX_LAUNCH_COMMAND_LENGTH = 500

export interface Settings {
  lang: 'na_id' | 'na_en'
  classicUi: boolean
  alternateRenderer: boolean

  downloadSpeedLimitKbps: number | null

  launchCommand: string | null
  // Troubleshooting logging defaults to off.
  troubleshootingMode: boolean
  // Preferred close-button behavior.
  windowCloseBehavior: 'minimize_to_tray' | 'exit'
  // Custom background filename; null selects the built-in image.
  customBackground: string | null
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'na_en',
  classicUi: false,
  alternateRenderer: false,
  downloadSpeedLimitKbps: null,
  launchCommand: null,
  troubleshootingMode: false,
  windowCloseBehavior: 'exit',
  customBackground: null
}

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json')
}

function clampDownloadSpeedLimitKbps(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) return null
  if (value < MIN_DOWNLOAD_SPEED_LIMIT_KBPS) return MIN_DOWNLOAD_SPEED_LIMIT_KBPS
  if (value > MAX_DOWNLOAD_SPEED_LIMIT_KBPS) return MAX_DOWNLOAD_SPEED_LIMIT_KBPS
  return value
}

function clampLaunchCommand(value: string | null): string | null {
  if (value === null) return null
  if (value.length === 0) return null
  return value.slice(0, MAX_LAUNCH_COMMAND_LENGTH)
}

function sanitizeWindowCloseBehavior(value: unknown): Settings['windowCloseBehavior'] {
  return value === 'minimize_to_tray' || value === 'exit' ? value : DEFAULT_SETTINGS.windowCloseBehavior
}

function sanitizeTroubleshootingMode(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_SETTINGS.troubleshootingMode
}

export async function readSettings(userDataDir: string): Promise<Settings> {
  try {
    const stored = await migrateRecord<Partial<Settings>>('launcher', 'settings', settingsPath(userDataDir), userDataDir)
    const merged = { ...DEFAULT_SETTINGS, ...stored } as Settings

    return {
      ...merged,
      downloadSpeedLimitKbps: clampDownloadSpeedLimitKbps(merged.downloadSpeedLimitKbps),
      launchCommand: clampLaunchCommand(merged.launchCommand),
      windowCloseBehavior: sanitizeWindowCloseBehavior(merged.windowCloseBehavior),
      troubleshootingMode: sanitizeTroubleshootingMode(merged.troubleshootingMode),
      customBackground: isValidBackgroundName(merged.customBackground) ? merged.customBackground : null
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SETTINGS
    throw err
  }
}

export async function writeSettings(userDataDir: string, settings: Settings): Promise<void> {
  const sanitized: Settings = {
    ...settings,
    downloadSpeedLimitKbps: clampDownloadSpeedLimitKbps(settings.downloadSpeedLimitKbps),
    launchCommand: clampLaunchCommand(settings.launchCommand),
    windowCloseBehavior: sanitizeWindowCloseBehavior(settings.windowCloseBehavior),
    troubleshootingMode: sanitizeTroubleshootingMode(settings.troubleshootingMode),
    customBackground: isValidBackgroundName(settings.customBackground) ? settings.customBackground : null
  }
  writeRecords('launcher', { settings: sanitized }, userDataDir)
}

let cachedWindowCloseBehavior: Settings['windowCloseBehavior'] = DEFAULT_SETTINGS.windowCloseBehavior

export function setCachedWindowCloseBehavior(value: Settings['windowCloseBehavior']): void {
  cachedWindowCloseBehavior = value
}

export function getCachedWindowCloseBehavior(): Settings['windowCloseBehavior'] {
  return cachedWindowCloseBehavior
}

export function buildGameLaunchArgs(settings: Settings): string[] {
  const args = ['-lang', settings.lang]
  if (settings.classicUi) args.push('--classicui')
  if (settings.alternateRenderer) args.push('-renderer')
  return args
}
