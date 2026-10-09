
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { fetchNews } from './news'

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
