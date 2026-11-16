import { createContext, useContext } from 'react'
import { ar } from './ar'
import { en, type MessageKey, type Messages } from './en'
import { es } from './es'
import { hi } from './hi'
import { id } from './id'
import { ru } from './ru'
import { zh } from './zh'

export const LANGS = [
  { code: 'en', name: 'English', dir: 'ltr', intl: 'en' },
  { code: 'zh', name: '中文', dir: 'ltr', intl: 'zh-CN' },
  { code: 'id', name: 'Bahasa Indonesia', dir: 'ltr', intl: 'id' },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr', intl: 'hi' },
  { code: 'es', name: 'Español', dir: 'ltr', intl: 'es' },
  { code: 'ar', name: 'العربية', dir: 'rtl', intl: 'ar' },
  { code: 'ru', name: 'Русский', dir: 'ltr', intl: 'ru' },
] as const

export type LangCode = (typeof LANGS)[number]['code']

export const CATALOG: Record<LangCode, Messages> = { en, zh, id, hi, es, ar, ru }
export const STORAGE_KEY = 'agent.lang'


export function isLang(v: string | null | undefined): v is LangCode {
  return LANGS.some((l) => l.code === v)
}

export function detect(): LangCode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    // Storage can be blocked inside an iframe; fall through to the browser language.
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLang(base)) return base
    if (base === 'in') return 'id' // legacy Indonesian code
  }
  return 'en'
}

export type Vars = Record<string, string | number>

export function fill(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

export interface I18n {
  lang: LangCode
  dir: 'ltr' | 'rtl'
  setLang: (l: LangCode) => void
  /** Typed lookup for a known key. */
  t: (key: MessageKey, vars?: Vars) => string
  /** Lookup for a key built at runtime (alert codes, statuses). Returns `fallback` when the key does not exist. */
  td: (key: string, fallback: string, vars?: Vars) => string
}

export const I18nContext = createContext<I18n | null>(null)

export function useI18n(): I18n {
  const v = useContext(I18nContext)
  if (!v) throw new Error('useI18n must be used inside I18nProvider')
  return v
}
