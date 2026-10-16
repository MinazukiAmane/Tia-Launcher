export function orderedFrameUrls(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([path]) => /\d+\.(png|jpe?g|webp)$/i.test(path))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([, url]) => url)
}

export const BACKGROUND_MODE_KEY = 'tia-background-mode'
export function saveBackgroundMode(mode: 'image' | 'video'): void {
 localStorage.setItem(BACKGROUND_MODE_KEY, mode)
 window.dispatchEvent(new Event('tia-background-mode-changed'))
}
