import { useEffect, useState } from 'react'

interface NewsItem {
  id: number
  title: string
  slug: string
  category: string
  image: string
  created_at: string
}

const CSO_RSE_BASE = 'https://cso-rse.my.id'

export function NoticesPanel(): React.JSX.Element | null {
  const [news, setNews] = useState<NewsItem[]>([])

  useEffect(() => {
    const unsubscribe = window.csore.onNews((items: NewsItem[]) => setNews(items))
    return unsubscribe
  }, [])

  if (news.length === 0) return null

  return (
    <div className="w-72 rounded-xl bg-black/50 backdrop-blur-sm border border-white/10 overflow-hidden">
      <div className="px-4 py-2 border-b border-white/10 text-xs font-semibold tracking-wide text-white/70">
        NOTICES
      </div>
      <ul className="max-h-48 overflow-y-auto">
        {news.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-white/5 transition"
              onClick={() => window.csore.openExternal(`${CSO_RSE_BASE}/news/${item.slug}`)}
            >
              <img
                src={`${CSO_RSE_BASE}/${item.image}`}
                alt=""
                className="h-10 w-10 rounded object-cover flex-shrink-0"
              />
              <div className="min-w-0">
                <div className="truncate text-sm text-white">{item.title}</div>
                <div className="text-xs text-white/50">
                  {item.category} · {new Date(item.created_at).toLocaleDateString()}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
