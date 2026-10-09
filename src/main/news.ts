
import type { BrowserWindow } from 'electron'

export interface NewsItem {
  id: number
  title: string
  slug: string
  category: string
  image: string
  created_at: string
}

interface NewsApiResponse {
  success: boolean
  message: string
  data: { news: NewsItem[] }
}

const NEWS_API_BASE = 'https://cso-rse.my.id'
const POLL_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

export async function fetchNews(apiBaseUrl: string = NEWS_API_BASE): Promise<NewsItem[]> {
  const res = await fetch(`${apiBaseUrl}/api/v1/news?method=apiv1`)
  if (!res.ok) throw new Error(`news request failed: HTTP ${res.status}`)
  const body = (await res.json()) as NewsApiResponse
  if (!body.success) throw new Error(`news API error: ${body.message}`)
  return body.data.news
}

export const NEWS_CHANNEL = 'news:update'

export function startNewsPolling(win: BrowserWindow): void {
  async function poll(): Promise<void> {
    try {
      const news = await fetchNews()
      if (!win.isDestroyed()) win.webContents.send(NEWS_CHANNEL, news)
    } catch {

    }
  }
  poll()
  setInterval(poll, POLL_INTERVAL_MS)
}
