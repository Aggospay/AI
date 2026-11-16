import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { setFormatLocale } from '@/lib/format'
import { CATALOG, I18nContext, LANGS, STORAGE_KEY, detect, fill, type I18n, type LangCode, type Vars } from './context'
import { en, type MessageKey } from './en'

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LangCode>(() => {
    const l = detect()
    setFormatLocale(LANGS.find((x) => x.code === l)?.intl ?? 'en')
    return l
  })
  const meta = LANGS.find((l) => l.code === lang) ?? LANGS[0]

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = meta.dir
  }, [lang, meta.dir])

  const setLang = useCallback((l: LangCode) => {
    setFormatLocale(LANGS.find((x) => x.code === l)?.intl ?? 'en')
    try {
      window.localStorage.setItem(STORAGE_KEY, l)
    } catch {
      // Not persisted when storage is unavailable; the choice still applies for this visit.
    }
    setLangState(l)
  }, [])

  const value = useMemo<I18n>(() => {
    const messages = CATALOG[lang]
    const t = (key: MessageKey, vars?: Vars) => fill(messages[key] ?? en[key], vars)
    const td = (key: string, fallback: string, vars?: Vars) => {
      const m = messages as Record<string, string | undefined>
      const hit = m[key] ?? (en as Record<string, string | undefined>)[key]
      return hit === undefined ? fallback : fill(m[key] ?? hit, vars)
    }
    return { lang, dir: meta.dir, setLang, t, td }
  }, [lang, meta.dir, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
