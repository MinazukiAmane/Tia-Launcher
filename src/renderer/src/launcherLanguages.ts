import languages from '../../shared/launcherLanguages.json'
import type { LauncherLanguage } from '../../shared/launcherLanguage'
export type { LauncherLanguage } from '../../shared/launcherLanguage'

export const LAUNCHER_LANGUAGES = languages as { code: LauncherLanguage; label: string }[]

export function isLauncherLanguage(value: unknown): value is LauncherLanguage {
  return LAUNCHER_LANGUAGES.some(language => language.code === value)
}
