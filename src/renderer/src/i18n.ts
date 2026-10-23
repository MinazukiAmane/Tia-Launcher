import mediaMessages from '../../shared/mediaMessages.json'
import { useEffect, useSyncExternalStore } from 'react'
import { isLauncherLanguage, type LauncherLanguage } from './launcherLanguages'
import messages from './locales/messages.json'

const catalog = { ...messages, ...mediaMessages }

let language: LauncherLanguage = 'en'
const listeners = new Set<() => void>()
const columns = { id: 0, 'zh-CN': 1, ko: 2, ja: 3, jv: 4 } as const
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function translate(text: string, locale: LauncherLanguage, values: Record<string, string | number> = {}): string {
  const translated = locale === 'en' ? text : (catalog as Record<string, string[]>)[text]?.[columns[locale]] ?? text
  return translated.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(values[key] ?? placeholder))
}

export function t(text: string, values?: Record<string, string | number>): string {
  return translate(text, language, values)
}

function applyLanguage(value: LauncherLanguage): void {
  language = value
  listeners.forEach(listener => listener())
}

export async function loadLauncherLanguage(): Promise<void> {
  const preferences = await window.csore.getPreferences()
  applyLanguage(isLauncherLanguage(preferences.launcherLanguage) ? preferences.launcherLanguage : 'en')
}

export async function changeLauncherLanguage(value: LauncherLanguage): Promise<void> {
  if (!isLauncherLanguage(value)) throw new Error('Unsupported launcher language.')
  await window.csore.setPreferences({ launcherLanguage: value })
  applyLanguage(value)
}

export function useLauncherLanguage(): LauncherLanguage {
  const current = useSyncExternalStore(subscribe, () => language)
  useEffect(() => { document.documentElement.lang = current }, [current])
  return current
}
