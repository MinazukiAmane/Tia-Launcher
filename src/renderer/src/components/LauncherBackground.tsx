import { resolveVideoSource } from '../mediaSource'
import { t } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import heroBackground from '../assets/hero-background.png'
import { migrateLegacyPreferences } from '../persistence'
import { orderedFrameUrls, saveBackgroundMode } from '../backgroundFrames'

const imageAssets = import.meta.glob<string>('../assets/backgrounds/images/*.{png,jpg,jpeg,webp,gif}', { eager: true, query: '?url', import: 'default' })
const explicitFrames = orderedFrameUrls(import.meta.glob<string>('../assets/backgrounds/frames/*.{png,jpg,jpeg,webp}', { eager: true, query: '?url', import: 'default' }))
const frames = explicitFrames.length ? explicitFrames : orderedFrameUrls(imageAssets)
const images = Object.entries(imageAssets).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([, url]) => url)
const videos = Object.entries(import.meta.glob<string>('../assets/backgrounds/videos/*.{mp4,webm}', { eager: true, query: '?url', import: 'default' })).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([, url]) => url)
type Mode = 'video' | 'image'

function BackgroundVideo({ url, active, centered, onError }: { url: string; active: boolean; centered: boolean; onError: () => void }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const element = video.current
    if (!element) return
    return () => { element.pause(); element.removeAttribute('src'); element.load() }
  }, [url])
  useEffect(() => {
    const element = video.current
    if (!element) return
    if (active) void element.play().catch(() => {})
    else element.pause()
  }, [active, url])
  return <video ref={video} className="background-media" style={{ visibility: active ? 'visible' : 'hidden', objectPosition: centered ? 'center' : 'left center' }} src={url} muted loop={!navigator.userAgent.includes('Linux')} onEnded={event => {
    if (!active) return
    const element = event.currentTarget
    element.currentTime = 0
    void element.play().catch(() => {})
  }} playsInline preload="metadata" onError={onError} aria-hidden="true" />
}

function FrameAnimation({ active }: { active: boolean }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!active || !frames.length) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let index = 0
    let current: HTMLImageElement | null = null
    const draw = (): void => {
      if (stopped) return
      const started = performance.now()
      const image = new Image()
      current = image
      image.onload = () => {
        if (stopped) return
        const target = canvas.current
        if (target) {
          const width = Math.min(1920, image.naturalWidth)
          const height = Math.round(width * image.naturalHeight / image.naturalWidth)
          if (target.width !== width || target.height !== height) { target.width = width; target.height = height }
          target.getContext('2d')?.drawImage(image, 0, 0, width, height)
        }
        index = (index + 1) % frames.length
        timer = setTimeout(draw, Math.max(0, 1000 / 24 - (performance.now() - started)))
      }
      image.onerror = () => { index = (index + 1) % frames.length; timer = setTimeout(draw, 100) }
      image.src = frames[index]
    }
    draw()
    return () => { stopped = true; clearTimeout(timer); if (current) { current.onload = null; current.onerror = null; current.src = '' } }
  }, [active])
  return <canvas ref={canvas} className="background-media" aria-hidden="true" />
}

export function LauncherBackground({ gameId, customUrl, inactive, fallbackUrl, fallbackVideoUrl }: { gameId: string; customUrl: string | null; inactive: boolean; fallbackUrl?: string; fallbackVideoUrl?: string }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(videos.length ? 'video' : 'image')
  const [sources, setSources] = useState<{ image: string | null; video: string | null }>({ image: null, video: null })
  const [visible, setVisible] = useState(!document.hidden)
  const [failedVideos, setFailedVideos] = useState<Set<string>>(() => new Set())
  const [players, setPlayers] = useState<Record<string, { url: string; original: string; centered: boolean }>>({})
  const sourcesGame = useRef(gameId)
  useEffect(() => {
    let mounted = true
    let latest = 0
    const refresh = (): void => {
      const request = ++latest
      window.csore.getBackgroundSources().then(value => { if (mounted && request === latest) { sourcesGame.current = gameId; setSources(value); setFailedVideos(new Set()) } }).catch(() => {})
    }
    refresh()
    window.addEventListener('tia-background-sources-changed', refresh)
    return () => { mounted = false; window.removeEventListener('tia-background-sources-changed', refresh) }
  }, [customUrl, gameId])
  useEffect(() => {
    const change = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  useEffect(() => {
    let mounted = true
    migrateLegacyPreferences().then(() => window.csore.getPreferences()).then(value => {
      if (mounted && value.backgroundMode) setMode(value.backgroundMode)
    }).catch(() => {})
    const update = (event: Event): void => setMode((event as CustomEvent<Mode>).detail)
    window.addEventListener('tia-background-mode-changed', update)
    return () => { mounted = false; window.removeEventListener('tia-background-mode-changed', update) }
  }, [])
  const currentSources = sourcesGame.current === gameId ? sources : { image: null, video: null }
  const imageUrl = currentSources.image ?? (customUrl && !customUrl.startsWith('tia-background:') ? customUrl : null) ?? fallbackUrl ?? images[0] ?? frames[0] ?? heroBackground
  const videoUrl = [currentSources.video, ...(fallbackVideoUrl ? [fallbackVideoUrl] : fallbackUrl ? [] : videos)].find(url => url && !failedVideos.has(url)) ?? null
  const animatedFrames = !fallbackUrl && mode === 'image' && !currentSources.image && (!customUrl || customUrl.startsWith('tia-background:')) && frames.length > 1
  const [resolvedVideo, setResolvedVideo] = useState<{ original: string; url: string } | null>(null)
  useEffect(() => {
    let canceled = false
    if (!videoUrl || !('__TAURI_INTERNALS__' in window) || !videoUrl.startsWith('/assets/') || import.meta.env.DEV) return
    const path = new URL(videoUrl, window.location.href).pathname
    const cached = Object.values(players).find(player => player.original === videoUrl)
    if (cached) { setResolvedVideo({ original: videoUrl, url: cached.url }); return }
    const request = resolveVideoSource(path)
    void request.then(url => {
      if (!canceled) setResolvedVideo({ original: videoUrl, url })
    }).catch(() => { if (!canceled) setFailedVideos(previous => new Set(previous).add(videoUrl)) })
    return () => { canceled = true }
  }, [videoUrl])
  const requiresResolution = !!videoUrl && '__TAURI_INTERNALS__' in window && videoUrl.startsWith('/assets/') && !import.meta.env.DEV
  const playbackUrl = requiresResolution ? (resolvedVideo?.original === videoUrl ? resolvedVideo.url : null) : videoUrl
  const playVideo = mode === 'video' && playbackUrl !== null
  const active = visible && !inactive
  useEffect(() => {
    if (!playbackUrl || !videoUrl) return
    setPlayers(previous => previous[gameId]?.url === playbackUrl ? previous : {
      ...previous, [gameId]: { url: playbackUrl, original: videoUrl, centered: videoUrl === currentSources.video || videoUrl === fallbackVideoUrl }
    })
  }, [gameId, playbackUrl, videoUrl, currentSources.video, fallbackVideoUrl])
  function select(value: Mode): void {
    const previous = mode
    setMode(value)
    void saveBackgroundMode(value).catch(() => setMode(previous))
  }
  return <>
    <div className="home-background" style={{ backgroundImage: `url(${imageUrl})`, backgroundPosition: currentSources.image || fallbackUrl ? 'center' : 'left center' }} />
    {animatedFrames && <FrameAnimation active={active} />}
    {Object.entries(players).map(([id, player]) => <BackgroundVideo key={id + player.url} url={player.url} centered={player.centered} active={active && playVideo && id === gameId && player.url === playbackUrl} onError={() => { if (id === gameId) setFailedVideos(previous => new Set(previous).add(player.original)) }} />)}
    <div data-tauri-drag-region="deep" className="background-switcher-zone" hidden={inactive}>
      <div className="background-switcher" role="group" aria-label={t("Background mode")}>
        <button type="button" aria-label={t("Video background")} aria-pressed={mode === 'video'} disabled={!videoUrl} title={videoUrl ? t("Video background") : t("No built-in video available")} onClick={() => select('video')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>
        </button>
        <button type="button" aria-label={t("Image background")} aria-pressed={mode === 'image'} title={t("Image / GIF / frame animation")} onClick={() => select('image')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1"/><path d="m5 18 5-5 3 3 3-4 4 6"/></svg>
        </button>
      </div>
    </div>
  </>
}
