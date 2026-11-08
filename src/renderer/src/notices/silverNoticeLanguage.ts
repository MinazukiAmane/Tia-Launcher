import type { SilverNotice, SilverNoticeTranslation } from '../../../shared/silverNotices'
const languages: Record<string, string> = { en: 'en_US', id: 'id_ID', jv: 'jv_ID', 'zh-CN': 'zh_CN', 'zh-TW': 'zh_TW', ja: 'ja_JP', ko: 'ko_KR' }
export function silverNoticeTranslation(item: SilverNotice, language: string): SilverNoticeTranslation {
  return item.translations.find(entry => entry.language === languages[language]) ?? item.translations.find(entry => entry.language === 'en_US') ?? item.translations[0]
}
