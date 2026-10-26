import { GAME_ARTWORK } from '../gameArtwork'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SilverNoticeFeed } from '../../../shared/silverNotices'
import { silverNoticeTranslation } from '../notices/silverNoticeLanguage'
import { t, useLauncherLanguage } from '../i18n'

export function SilverNoticesPanel(): React.JSX.Element {
  const language = useLauncherLanguage()
  const [feed, setFeed] = useState<SilverNoticeFeed>({ items: [], available: false, stale: false })
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  const [carouselIndex, setCarouselIndex] = useState(0)
  const [carouselPaused, setCarouselPaused] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  async function refresh(): Promise<void> {
    setLoading(true)
    try { const next = await window.csore.getSilverNotices(); if (mounted.current) setFeed(next) }
    catch { /* Preserve any previously received bulletin during IPC shutdown. */ }
    finally { if (mounted.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.csore.onSilverNotices(next => { setFeed(next); setLoading(false) })
    void refresh()
    return () => { mounted.current = false; unsubscribe() }
  }, [])
  const active = feed.items.find(item => item.id === selected)
  const content = active ? silverNoticeTranslation(active, language) : null
  useEffect(() => {
    if (selected !== null && active && !dialog.current?.open) dialog.current?.showModal()
    if (!active && dialog.current?.open) dialog.current.close()
  }, [selected, active])
  const items = useMemo(() => feed.items.filter(item => tab === 'all' || item.category === tab), [feed.items, tab])
  const slides = useMemo(() => {
    const illustrated = items.filter(item => item.image)
    return illustrated.length ? illustrated : items
  }, [items])
  const slide = slides[Math.min(carouselIndex, Math.max(slides.length - 1, 0))]
  const slideText = slide ? silverNoticeTranslation(slide, language) : null
  useEffect(() => { setCarouselIndex(0) }, [tab])
  useEffect(() => {
    if (slides.length < 2 || carouselPaused || selected !== null) return
    const timer = setInterval(() => setCarouselIndex(index => (index + 1) % slides.length), 5000)
    return () => clearInterval(timer)
  }, [slides.length, carouselPaused, selected])
  function date(value: number): string { return new Date(value).toLocaleDateString(language, { month: 'short', day: 'numeric', year: 'numeric' }) }
  return <>
    <section className="silver-notices" aria-label={t('Game news')}>
      <div className="silver-notice-layout">
      <div className="silver-notice-art" aria-roledescription="carousel" aria-label={t('Game news')}
        onMouseEnter={() => setCarouselPaused(true)} onMouseLeave={() => setCarouselPaused(false)}
        onFocus={() => setCarouselPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCarouselPaused(false) }}>
        {slide ? <>
          <button type="button" className="silver-notice-banner" onClick={() => setSelected(slide.id)} title={slideText?.title} aria-label={slideText?.title}>
            <img src={slide.image ?? GAME_ARTWORK.cedar_global} alt={slideText?.shortTitle ?? ''} />
          </button>
          {slides.length > 1 && <div className="silver-notice-dots">{slides.map((item, index) => <button key={item.id} type="button" aria-label={silverNoticeTranslation(item, language).shortTitle} aria-pressed={slide.id === item.id} onClick={() => setCarouselIndex(index)} />)}</div>}
        </> : <div className="silver-notice-art-empty">Silver Palace</div>}
      </div>
      <div className="silver-notice-copy">
      <div className="silver-notice-toolbar">
      <div className="notices-tabs" role="tablist" aria-label={t('News category')}>
        {([['all', 'Notices'], ['event', 'Events'], ['news', 'News']] as const).map(([key, title]) => <button key={key} type="button" role="tab" id={`silver-tab-${key}`} aria-controls="silver-notice-items" aria-selected={tab === key} onClick={() => setTab(key)} className={tab === key ? 'notice-tab is-active' : 'notice-tab'}>{t(title)}</button>)}
      </div>
      <button type="button" className="silver-notice-refresh" onClick={() => void refresh()} disabled={loading} aria-label={t('Refresh notices')} title={t('Refresh notices')}>↻</button>
      </div>
      <ul className="silver-notice-list" id="silver-notice-items" role="tabpanel" aria-labelledby={`silver-tab-${tab}`} aria-busy={loading}>
        {items.map(item => { const translation = silverNoticeTranslation(item, language); return <li key={item.id}><button type="button" className="notice-row" onClick={() => setSelected(item.id)} title={translation.title}><span className="notice-title">{translation.shortTitle}</span>{item.createdAt > 0 && <time className="notice-date" dateTime={new Date(item.createdAt).toISOString()}>{date(item.createdAt)}</time>}<span aria-hidden="true">›</span></button></li> })}
        {!items.length && <li className="silver-notice-status" role="status">{loading ? t('Loading…') : !feed.available ? t('Notices are temporarily unavailable.') : t('Nothing here yet.')}</li>}
      </ul>
      {feed.stale && <p className="silver-notice-stale" role="status">{t('Showing previously loaded notices.')}</p>}
      </div>
      </div>
    </section>
    <dialog className="silver-notice-dialog" ref={dialog} aria-labelledby="silver-notice-title" onClose={() => setSelected(null)} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close() } }}>
      <header><div><p>Silver Palace · {t(active?.category === 'event' ? 'Events' : 'News')}</p><h2 id="silver-notice-title">{content?.title}</h2>{active && active.createdAt > 0 && <time dateTime={new Date(active.createdAt).toISOString()}>{date(active.createdAt)}</time>}</div><button type="button" onClick={() => dialog.current?.close()} aria-label={t('Close')} autoFocus>×</button></header>
      <article className="silver-notice-content" tabIndex={0}>{active?.image && <img className="silver-notice-hero" src={active.image} alt={content?.title ?? ''} />}<div>{content?.content}</div></article>
    </dialog>
  </>
}
