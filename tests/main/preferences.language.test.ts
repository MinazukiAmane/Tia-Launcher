import { describe, expect, it, vi } from 'vitest'
import { readPreferences, writePreferences } from '../../src/main/preferences'
import { DEFAULT_SETTINGS, buildGameLaunchArgs } from '../../src/main/settings'
import { LAUNCHER_LANGUAGES } from '../../src/renderer/src/launcherLanguages'

describe('persisted launcher language', () => {
  it('keeps each language after a module reload without changing background, install path, or game arguments', async () => {
    writePreferences({ backgroundMode: 'image', confirmedInstallDir: '/games/custom' })
    const args = buildGameLaunchArgs(DEFAULT_SETTINGS)
    for (const language of LAUNCHER_LANGUAGES) {
      writePreferences({ launcherLanguage: language.code })
      vi.resetModules()
      const reloaded = await import('../../src/main/preferences')
      expect(reloaded.readPreferences()).toEqual({ launcherLanguage: language.code, backgroundMode: 'image', confirmedInstallDir: '/games/custom' })
      expect(buildGameLaunchArgs(DEFAULT_SETTINGS)).toEqual(args)
    }
  })

  it('rejects an unsupported language and preserves the previous saved value', () => {
    writePreferences({ launcherLanguage: 'ja' })
    expect(() => writePreferences({ launcherLanguage: 'invalid' as 'ja' })).toThrow('Unsupported launcher language.')
    expect(readPreferences().launcherLanguage).toBe('ja')
    writePreferences({ backgroundMode: 'video' }, true)
    expect(readPreferences().launcherLanguage).toBe('ja')
  })
})
