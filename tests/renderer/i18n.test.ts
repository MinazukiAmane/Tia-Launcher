import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAUNCHER_LANGUAGES } from '../../src/renderer/src/launcherLanguages'
import messages from '../../src/renderer/src/locales/messages.json'
import { translate } from '../../src/renderer/src/i18n'

afterEach(() => vi.unstubAllGlobals())

describe('launcher translations', () => {
  it('provides every translated message in all four additional languages without losing placeholders', () => {
    const placeholders = (value: string): string[] => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort()
    for (const [english, translations] of Object.entries(messages)) {
      expect(translations, english).toHaveLength(4)
      for (const translation of translations) {
        expect(translation.trim(), english).not.toBe('')
        expect(placeholders(translation), english).toEqual(placeholders(english))
      }
    }
    expect(LAUNCHER_LANGUAGES.map(language => language.code)).toEqual(['en', 'id', 'zh-CN', 'ko', 'ja'])
  })

  it('translates progress with values and preserves server text and unknown placeholders', () => {
    expect(translate('Downloading… {percent}%', 'ja', { percent: 42 })).toBe('ダウンロード中… 42%')
    expect(translate('Game Version: {version}', 'zh-CN', { version: '1.2.3' })).toBe('游戏版本：1.2.3')
    expect(translate('Play', 'ko')).toBe('플레이')
    expect(translate('Play', 'id')).toBe('Mainkan')
    expect(translate('Game Version: {version}', 'en')).toBe('Game Version: {version}')
    expect(translate('Server news title', 'id')).toBe('Server news title')
  })

  it('restores a saved language and changes the visible language only after persistence succeeds', async () => {
    vi.resetModules()
    const save = vi.fn().mockResolvedValue({ launcherLanguage: 'ko' })
    vi.stubGlobal('window', { csore: { getPreferences: async () => ({ launcherLanguage: 'ja' }), setPreferences: save } })
    const { loadLauncherLanguage, changeLauncherLanguage, t } = await import('../../src/renderer/src/i18n')
    await loadLauncherLanguage()
    expect(t('Play')).toBe('プレイ')
    save.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(changeLauncherLanguage('ko')).rejects.toThrow('database unavailable')
    expect(t('Play')).toBe('プレイ')
    await changeLauncherLanguage('ko')
    expect(save).toHaveBeenLastCalledWith({ launcherLanguage: 'ko' })
    expect(t('Play')).toBe('플레이')
  })

  it('keeps English as the default for existing installations without a launcher language', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { csore: { getPreferences: async () => ({ backgroundMode: 'image' }) } })
    const { loadLauncherLanguage, t } = await import('../../src/renderer/src/i18n')
    await loadLauncherLanguage()
    expect(t('Play')).toBe('Play')
  })
})
