
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { fetchNews, startNewsPolling, getCachedNews } from '../../src/main/news'

const SAMPLE_RESPONSE = {
  success: true,
  message: 'Success retreived news',
  data: {
    news: [
      {
        id: 3,
        title: 'RSE All Star Mode Event!',
        slug: 'rse-all-star-mode-event',
        category: 'event',
        image: 'uploads/news/thumbnails/df111cc6-048b-40e5-a7b2-315e5f93455b.jpg',
        created_at: '2026-10-09T16:00:00.000000Z'
      },
      {
        id: 2,
        title: 'Early Access is Now Open - Pengumuman Early Access',
        slug: 'early-access-is-now-open-pengumuman-early-access',
        category: 'info',
        image: 'uploads/news/thumbnails/5972f2fd-f232-40a9-87b0-17f744da0a20.png',
        created_at: '2026-10-05T09:27:14.000000Z'
      }
    ]
  }
}

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(SAMPLE_RESPONSE))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => server.close())

describe('fetchNews', () => {
  it('returns the news array on success', async () => {
    const got = await fetchNews(baseUrl)
    expect(got).toHaveLength(2)
    expect(got[0].title).toBe('RSE All Star Mode Event!')
    expect(got[0].slug).toBe('rse-all-star-mode-event')
  })
})

describe('startNewsPolling caches the latest successful fetch', () => {
  it('getCachedNews reflects the first poll, for a renderer that mounts after it fired', async () => {
    const sampleNews = [
      { id: 1, title: 'Cached Item', slug: 'cached-item', category: 'info', image: 'i.png', created_at: '2026-01-01T00:00:00Z' }
    ]
    const originalFetch = global.fetch
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, message: 'ok', data: { news: sampleNews } }), { status: 200 })
    ) as unknown as typeof fetch

    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockReturnValue(0 as unknown as ReturnType<typeof setInterval>)

    try {
      const fakeWin = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      } as unknown as import('electron').BrowserWindow
      startNewsPolling(fakeWin)

      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      expect(getCachedNews()).toEqual(sampleNews)
    } finally {
      setIntervalSpy.mockRestore()
      global.fetch = originalFetch
    }
  })
})
