import { useEffect, useMemo, useState } from 'react'

interface NewsItem {
  id: number
  title: string
  slug: string
  category: string
  image: string
  created_at: string
}

const CSO_RSE_BASE = 'https://cso-rse.my.id'
const DISCORD_INVITE_URL = 'https://discord.gg/bte-rse'
const CAROUSEL_INTERVAL_MS = 5000

type TabKey = 'notices' | 'events' | 'news'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'notices', label: 'Notices' },
  { key: 'events', label: 'Events' },
  { key: 'news', label: 'News' }
]

function matchesTab(item: NewsItem, tab: TabKey): boolean {
  if (tab === 'notices') return true
  if (tab === 'events') return item.category === 'event'
  return item.category !== 'event'
}

function DiscordIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.07.07 0 0 0-.075.035c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.035A19.74 19.74 0 0 0 3.68 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.073.073 0 0 1 .078.01c.12.099.246.197.373.291a.077.077 0 0 1-.006.128 12.3 12.3 0 0 1-1.873.892.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.673-3.549-13.66a.06.06 0 0 0-.031-.028M8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418m7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418" />
    </svg>
  )
}

export function NoticesPanel(): React.JSX.Element | null {
  const [news, setNews] = useState<NewsItem[]>([])
  const [activeTab, setActiveTab] = useState<TabKey>('notices')
  const [carouselIndex, setCarouselIndex] = useState(0)

  useEffect(() => {
    window.csore.getNews().then((items: NewsItem[]) => setNews(items))
    const unsubscribe = window.csore.onNews((items: NewsItem[]) => setNews(items))
    return unsubscribe
  }, [])

  const filtered = useMemo(() => news.filter((item) => matchesTab(item, activeTab)), [news, activeTab])

  useEffect(() => {
    setCarouselIndex(0)
  }, [activeTab])

  useEffect(() => {
    if (filtered.length <= 1) return // nothing to rotate through
    const id = setInterval(() => {
      setCarouselIndex((i) => (i + 1) % filtered.length)
    }, CAROUSEL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [filtered.length])

  if (news.length === 0) return null

  const current = filtered[Math.min(carouselIndex, Math.max(filtered.length - 1, 0))]

  return (
    <section aria-label="Game news" className="notices-panel">
      <div className="notices-card">
        {/* Carousel */}
        <div className="notices-art">
          {current ? (
            <>
              <button
                type="button"
                onClick={() => window.csore.openExternal(`${CSO_RSE_BASE}/news/${current.slug}`)}
                className="block h-full w-full"
                title={current.title}
              >
                <img
                  src={`${CSO_RSE_BASE}/${current.image}`}
                  alt={current.title}
                  className="h-full w-full object-cover"
                />
              </button>
              {filtered.length > 1 && (
                <div className="absolute bottom-1.5 left-0 right-0 flex items-center justify-center gap-1">
                  {filtered.map((item, i) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setCarouselIndex(i)}
                      title={item.title}
                      className={`h-1.5 w-1.5 rounded-full transition ${
                        i === carouselIndex ? 'bg-white' : 'bg-white/40 hover:bg-white/70'
                      }`}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center px-3 text-center text-xs text-white/40">
              No items in this category.
            </div>
          )}
        </div>

        {/* Tabbed list */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="notices-tabs" role="tablist" aria-label="News category">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                aria-controls="news-items"
                id={`news-tab-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                className={activeTab === tab.key ? 'notice-tab is-active' : 'notice-tab'}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <ul id="news-items" role="tabpanel" aria-labelledby={`news-tab-${activeTab}`} className="notices-list">
            {filtered.length === 0 ? (
              <li className="px-4 py-3 text-xs text-white/40">Nothing here yet.</li>
            ) : (
              filtered.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="notice-row"
                    title={item.title}
                    onClick={() => window.csore.openExternal(`${CSO_RSE_BASE}/news/${item.slug}`)}
                  >
                    <span className="notice-title">{item.title}</span>
                    <time className="notice-date" dateTime={item.created_at}>
                      {new Date(item.created_at).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })}
                    </time>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

    </section>
  )
}

export function CommunityLink(): React.JSX.Element {
  return <button type="button" onClick={() => window.csore.openExternal(DISCORD_INVITE_URL)} title="Join our Discord" aria-label="Join our Discord"><DiscordIcon /></button>
}
