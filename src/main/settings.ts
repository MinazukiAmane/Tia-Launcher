
import { promises as fs } from 'fs'
import { join } from 'path'

export interface Settings {
  lang: 'na_id' | 'na_en'
  classicUi: boolean
  alternateRenderer: boolean

  downloadSpeedLimitMbps: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'na_en',
  classicUi: false,
  alternateRenderer: false,
  downloadSpeedLimitMbps: null
}

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json')
}

export async function readSettings(userDataDir: string): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsPath(userDataDir), 'utf-8')
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SETTINGS
    throw err
  }
}

export async function writeSettings(userDataDir: string, settings: Settings): Promise<void> {
  await fs.writeFile(settingsPath(userDataDir), JSON.stringify(settings, null, 2), 'utf-8')
}

export function buildGameLaunchArgs(settings: Settings): string[] {
  const args = ['-lang', settings.lang]
  if (settings.classicUi) args.push('-classicui')
  if (settings.alternateRenderer) args.push('-renderer')
  return args
}
