import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { currentWindow, type WindowSource } from './windowSource'
import type { SilverNotice, SilverNoticeFeed, SilverNoticeTranslation } from '../shared/silverNotices'

export const SILVER_NOTICE_CHANNEL = 'silver-notices:update'
const MAX_BYTES = 256 * 1024
const POLL_MS = 15 * 60 * 1000

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid notice response')
  return value as Record<string, unknown>
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid notice number')
  return value as number
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error('Invalid notice text')
  return value
}
// Unreal rich text is data, never browser HTML. Strip runs before decoding
// entities so escaped literal angle brackets remain visible as ordinary text.
export function noticePlainText(value: string): string {
  return value.replace(/<\/>|<\/?[a-z][^<>]*>/gi, '').replace(/&(lt|gt|amp|quot|apos|#39|#\d+|#x[\da-f]+);/gi, (entity, code: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" }
    if (named[code.toLowerCase()]) return named[code.toLowerCase()]
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : entity
  })
}
export function parseSilverNotices(value: unknown): SilverNotice[] {
  const body = record(value)
  if (body.code !== 0) throw new Error('Notice service unavailable')
  const rows = record(body.ret).data
  if (!Array.isArray(rows) || rows.length > 64) throw new Error('Invalid notice list')
  const seen = new Set<number>()
  return rows.flatMap(raw => {
    const row = record(raw), id = integer(row.noticeId), kind = integer(row.noticeType)
    if (!id || seen.has(id) || ![1, 2].includes(kind)) throw new Error('Invalid notice identity')
    seen.add(id)
    const deleted = integer(row.isDelete ?? 0)
    if (deleted > 1) throw new Error('Invalid notice status')
    const startsAt = integer(row.pushTime ?? 0), endsAt = integer(row.endTime ?? 0)
    if (endsAt && endsAt <= startsAt) throw new Error('Invalid notice schedule')
    const contents = row.contentList
    if (!Array.isArray(contents) || !contents.length || contents.length > 16) throw new Error('Invalid notice translations')
    const languages = new Set<string>()
    const translations: SilverNoticeTranslation[] = contents.map(rawContent => {
      const content = record(rawContent), language = text(content.languageType, 32)
      if (languages.has(language)) throw new Error('Duplicate notice translation')
      languages.add(language)
      return { language, title: text(content.longTitle, 200), shortTitle: text(content.shortTitle, 100), content: noticePlainText(text(content.noticeContent, 32000)) }
    })
    const item: SilverNotice = { id, category: kind === 2 ? 'event' : 'news', createdAt: integer(row.createTime ?? 0), startsAt, endsAt, priority: integer(row.priority ?? 0), translations }
    return deleted ? [] : [item]
  }).sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt || b.id - a.id)
}
export function visibleSilverNotices(items: SilverNotice[], now = Date.now()): SilverNotice[] {
  return items.filter(item => (!item.startsAt || item.startsAt <= now) && (!item.endsAt || item.endsAt > now))
}

async function serviceEndpoint(): Promise<string> {
  const root = app.isPackaged ? join(process.resourcesPath, 'game-runtime') : join(process.cwd(), 'build/native/cedar')
  const settings = record(JSON.parse(await readFile(join(root, 'launcher-services.json'), 'utf8')))
  if (settings.version !== 1) throw new Error('Unsupported launcher services configuration')
  const endpoint = text(settings.notices, 2048), url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid notice service configuration')
  return endpoint
}
export async function fetchSilverNotices(endpoint: string): Promise<SilverNotice[]> {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000), credentials: 'omit' })
  if (!response.ok || !response.body) throw new Error('Notice request failed')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > MAX_BYTES) throw new Error('Notice response exceeds size limit')
      chunks.push(result.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return parseSilverNotices(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}
let cached: SilverNotice[] = []
let available = false, stale = false
let pending: Promise<SilverNoticeFeed> | null = null
export function getSilverNoticeFeed(): SilverNoticeFeed {
  return { items: visibleSilverNotices(cached), available, stale }
}
export function refreshSilverNotices(): Promise<SilverNoticeFeed> {
  if (pending) return pending
  pending = (async () => {
    try { cached = await fetchSilverNotices(await serviceEndpoint()); available = true; stale = false }
    catch { stale = available }
    return getSilverNoticeFeed()
  })().finally(() => { pending = null })
  return pending
}
export function startSilverNoticePolling(win: WindowSource): void {
  const poll = async (): Promise<void> => { await refreshSilverNotices(); currentWindow(win)?.webContents.send(SILVER_NOTICE_CHANNEL, getSilverNoticeFeed()) }
  void poll()
  setInterval(() => { void poll() }, POLL_MS)
}
