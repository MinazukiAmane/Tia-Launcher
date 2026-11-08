import { activeGame, gamePreferenceScope } from './activeGame'
import languages from '../shared/launcherLanguages.json'
import type { LauncherLanguage } from '../shared/launcherLanguage'
import { readRecord, writeRecords } from './localDatabase'

export interface Preferences {
  launcherLanguage?: LauncherLanguage
  backgroundMode: 'image' | 'video' | null
  confirmedInstallDir: string | null
}

export function readPreferences(): Preferences {
  const global = { backgroundMode: null, confirmedInstallDir: null, ...readRecord<Partial<Preferences>>('launcher', 'preferences') }
  if (activeGame().biz !== 'csore_global') global.confirmedInstallDir = readRecord<Partial<Preferences>>(gamePreferenceScope(), 'preferences')?.confirmedInstallDir ?? null
  return global
}

export function writePreferences(update: Partial<Preferences>, onlyMissing = false): Preferences {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('Invalid launcher preferences.')
  const next = readPreferences()
  if ('backgroundMode' in update) {
    if (update.backgroundMode !== null && update.backgroundMode !== 'image' && update.backgroundMode !== 'video') throw new Error('Invalid background mode.')
    if (!onlyMissing || next.backgroundMode === null) next.backgroundMode = update.backgroundMode!
  }
  if ('confirmedInstallDir' in update) {
    if (update.confirmedInstallDir !== null && (typeof update.confirmedInstallDir !== 'string' || update.confirmedInstallDir.length > 32768)) throw new Error('Invalid installation folder.')
    if (!onlyMissing || next.confirmedInstallDir === null) next.confirmedInstallDir = update.confirmedInstallDir!
  }
  if ('launcherLanguage' in update) {
    if (!languages.some(language => language.code === update.launcherLanguage)) throw new Error('Unsupported launcher language.')
    if (!onlyMissing || next.launcherLanguage === undefined) next.launcherLanguage = update.launcherLanguage as LauncherLanguage
  }
  if (activeGame().biz === 'csore_global') writeRecords('launcher', { preferences: next })
  else {
    const prior = readRecord<Partial<Preferences>>('launcher', 'preferences')
    writeRecords(gamePreferenceScope(), { preferences: { confirmedInstallDir: next.confirmedInstallDir } })
    writeRecords('launcher', { preferences: { ...next, confirmedInstallDir: prior?.confirmedInstallDir ?? null } })
  }
  return next
}
