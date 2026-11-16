import { useState } from 'react'
import { Bot, KeyRound } from 'lucide-react'
import { LanguageSelect, useI18n } from '@/i18n'
import { Btn, inputCls } from './ui'

export function Gate({ onSubmit, error }: { onSubmit: (token: string) => void; error?: string }) {
  const { t } = useI18n()
  const [token, setToken] = useState('')
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8 flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--surface-strong)]">
          <Bot size={22} aria-hidden />
        </div>
        <div>
          <h1 className="display text-2xl font-semibold">{t('app.title')}</h1>
          <p className="text-sm text-[var(--subtle)]">{t('gate.subtitle')}</p>
        </div>
        <LanguageSelect className="ms-auto" />
      </div>
      <form
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (token.trim()) onSubmit(token.trim())
        }}
      >
        <label className="block">
          <span className="flex items-center gap-2 text-sm font-medium text-[var(--ink-2)]">
            <KeyRound size={15} aria-hidden /> {t('gate.token')}
          </span>
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('gate.placeholder')}
            dir="ltr"
            className={`${inputCls} mt-2 mono`}
          />
        </label>
        {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}
        <Btn variant="primary" type="submit" className="mt-4 w-full">{t('gate.connect')}</Btn>
        <p className="mt-4 text-xs leading-relaxed text-[var(--subtle)]">
          {t('gate.help')}
        </p>
      </form>
    </main>
  )
}
