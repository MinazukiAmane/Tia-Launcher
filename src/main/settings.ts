
import { promises as fs } from 'fs'
import { join } from 'path'

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
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'na_en',
  classicUi: false,
  alternateRenderer: false,
  downloadSpeedLimitKbps: null,
  launchCommand: null,
  troubleshootingMode: false,
  windowCloseBehavior: 'exit'
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

export async function readSettings(userDataDir: string): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsPath(userDataDir), 'utf-8')
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings

    return {
      ...merged,
      downloadSpeedLimitKbps: clampDownloadSpeedLimitKbps(merged.downloadSpeedLimitKbps),
      launchCommand: clampLaunchCommand(merged.launchCommand)
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
    launchCommand: clampLaunchCommand(settings.launchCommand)
  }
  await fs.writeFile(settingsPath(userDataDir), JSON.stringify(sanitized, null, 2), 'utf-8')
}

export function buildGameLaunchArgs(settings: Settings): string[] {
  const args = ['-lang', settings.lang]
  if (settings.classicUi) args.push('-classicui')
  if (settings.alternateRenderer) args.push('-renderer')
  return args
}
