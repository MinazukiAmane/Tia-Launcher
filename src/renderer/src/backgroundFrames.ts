export function orderedFrameUrls(sources: Record<string, string>): string[] {
  return Object.entries(sources)
    .filter(([path]) => /\d+\.(png|jpe?g|webp)$/i.test(path))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([, url]) => url)
}

export async function saveBackgroundMode(mode: 'image' | 'video'): Promise<void> {
 await window.csore.setPreferences({ backgroundMode: mode })
 window.dispatchEvent(new CustomEvent('tia-background-mode-changed', { detail: mode }))
}
