export interface SilverNoticeTranslation {
  language: string
  title: string
  shortTitle: string
  content: string
}
export interface SilverNotice {
  id: number
  category: 'news' | 'event'
  image?: string
  createdAt: number
  startsAt: number
  endsAt: number
  priority: number
  translations: SilverNoticeTranslation[]
}
export interface SilverNoticeFeed {
  items: SilverNotice[]
  available: boolean
  stale: boolean
}
