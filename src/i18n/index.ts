import { useSyncExternalStore } from 'react'
import en from './en.json'

export type Locale = 'zh-CN' | 'en'
export const LANGUAGE_STORAGE_KEY = 'qwen-audio-toolkits.language-v1'
const listeners = new Set<() => void>()
const english: Readonly<Record<string, string>> = en

export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : 'zh-CN'
}

function readLocale(): Locale {
  try {
    return normalizeLocale(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY))
  } catch {
    return 'zh-CN'
  }
}

let locale = readLocale()
export const getLocale = () => locale

function applyLocale(next: Locale) {
  if (typeof document !== 'undefined') document.documentElement.lang = next
  if (locale === next) return
  locale = next
  listeners.forEach(listener => listener())
}

export function setLocale(next: Locale) {
  const normalized = normalizeLocale(next)
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, normalized)
  } catch {
    // Language still changes for this session when storage is unavailable.
  }
  applyLocale(normalized)
}

export function subscribeLocale(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Subscribe without remounting the component or interrupting active tasks. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => 'zh-CN')
}

/** Chinese source text is the fallback; only explicit UI messages are translated. */
export function translate(source: string, values: readonly unknown[] = [], language: Locale = locale): string {
  const message = language === 'en' ? english[source] ?? source : source
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)] ?? '') : placeholder,
  )
}
export const t = translate

if (typeof window !== 'undefined') {
  applyLocale(locale)
  // Webviews on the same app origin share storage, including the caption window.
  window.addEventListener('storage', event => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) applyLocale(readLocale())
  })
}
