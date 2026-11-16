import { Languages } from 'lucide-react'
import { LANGS, isLang, useI18n } from './context'

/** Native <select>: accessible, keyboard friendly, and each language is named in its own script. */
export function LanguageSelect({ className = '' }: { className?: string }) {
  const { lang, setLang, t } = useI18n()
  return (
    <label className={`relative inline-flex items-center ${className}`}>
      <span className="sr-only">{t('lang.label')}</span>
      <Languages size={15} aria-hidden className="pointer-events-none absolute start-3 text-[var(--subtle)]" />
      <select
        value={lang}
        onChange={(e) => {
          if (isLang(e.target.value)) setLang(e.target.value)
        }}
        className="min-h-11 cursor-pointer appearance-none rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] py-0 pe-3 ps-9 text-sm text-[var(--ink)] hover:bg-[var(--surface-strong)]"
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code} lang={l.code} className="bg-[#1f2f44]">
            {l.name}
          </option>
        ))}
      </select>
    </label>
  )
}
