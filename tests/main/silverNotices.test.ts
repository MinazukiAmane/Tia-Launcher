import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { fetchSilverNotices, noticePlainText, parseSilverNotices, visibleSilverNotices } from '../../src/main/silverNotices'
import { silverNoticeTranslation } from '../../src/renderer/src/notices/silverNoticeLanguage'
vi.mock('electron', () => ({ app: { isPackaged: false } }))
function row(id = 1, changes: Record<string, unknown> = {}) {
  return { noticeId: id, noticeType: 1, createTime: 1000, pushTime: 0, endTime: 0, priority: 0, isDelete: 0,
    contentList: [{ languageType: 'en_US', shortTitle: 'Patch notes', longTitle: 'Server update', noticeContent: '<Text>Welcome &amp; enjoy!</>\n\n<Title1>Updates</>\n<Text>Use &lt;item&gt;.</>' }], ...changes }
}
const body = (rows = [row()]): unknown => ({ code: 0, message: '', ret: { data: rows } })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('parses native notices, removes deleted rows, sorts priority/date, and respects publication windows', () => {
  const items = parseSilverNotices(body([row(1), row(2, { noticeType: 2, priority: 20 }), row(3, { isDelete: 1 }), row(4, { pushTime: 5000 }), row(5, { endTime: 2000 })]))
  expect(items.map(item => item.id)).toEqual([2, 5, 4, 1])
  expect(visibleSilverNotices(items, 3000).map(item => item.id)).toEqual([2, 1])
  expect(items[0].category).toBe('event')
  expect(items[0].translations[0].content).toBe('Welcome & enjoy!\n\nUpdates\nUse <item>.')
  expect(items[0]).not.toHaveProperty('url')
})
it('never treats rich text or escaped HTML as executable markup, and does not double-decode', () => {
  expect(noticePlainText('<Text>&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt; &#65; &#x42; &#0;</>')).toBe('<script>alert(1)</script> &lt; A B &#0;')
})
it('selects the launcher language and falls back to English, then the first available translation', () => {
  const item = parseSilverNotices(body())[0]
  item.translations.push({ language: 'ja_JP', title: '更新', shortTitle: '更新', content: '詳細' })
  expect(silverNoticeTranslation(item, 'ja').content).toBe('詳細')
  expect(silverNoticeTranslation(item, 'id').language).toBe('en_US')
  expect(silverNoticeTranslation(item, 'jv').language).toBe('en_US')
  item.translations.shift()
  expect(silverNoticeTranslation(item, 'en').language).toBe('ja_JP')
})
it('rejects malformed API data rather than clearing a valid bulletin', () => {
  for (const value of [{ code: 404 }, body([row(), row()]), body([row(1, { contentList: [] })]), body([row(1, { endTime: 10, pushTime: 20 })]), body([row(1, { noticeType: 3 })])]) expect(() => parseSilverNotices(value)).toThrow()
})
it('fetches with no credentials and rejects unsuccessful or oversized responses', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body())))
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(new Response('x'.repeat(256 * 1024 + 1)))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchSilverNotices('https://fixture.test/notices')).toHaveLength(1)
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', signal: expect.any(AbortSignal) })
  await expect(fetchSilverNotices('https://fixture.test/notices')).rejects.toThrow('Notice request failed')
  await expect(fetchSilverNotices('https://fixture.test/notices')).rejects.toThrow('size limit')
})
it('loads the private configuration only in main, coalesces refreshes, retains cached notices on failure and accepts a successful empty feed', async () => {
  vi.resetModules()
  const service = await import('../../src/main/silverNotices')
  const root = await mkdtemp(join(tmpdir(), 'tia-notice-service-'))
  try {
    const config = join(root, 'build/native/cedar'); await mkdir(config, { recursive: true })
    await writeFile(join(config, 'launcher-services.json'), JSON.stringify({ version: 1, notices: 'https://fixture.test/notices' }))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body())))
      .mockResolvedValueOnce(new Response('{}', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(body([]))))
    vi.stubGlobal('fetch', fetch)
    const first = service.refreshSilverNotices(), duplicate = service.refreshSilverNotices()
    expect(duplicate).toBe(first)
    expect(await first).toMatchObject({ available: true, stale: false, items: [expect.objectContaining({ id: 1 })] })
    expect(await service.refreshSilverNotices()).toMatchObject({ available: true, stale: true, items: [expect.objectContaining({ id: 1 })] })
    expect(await service.refreshSilverNotices()).toEqual({ available: true, stale: false, items: [] })
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally { await rm(root, { recursive: true, force: true }) }
})
