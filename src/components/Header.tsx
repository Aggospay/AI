import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { OctagonAlert, Pause, Play } from 'lucide-react'
import type { AgentState } from '@/lib/api'
import { useAction } from '@/lib/hooks'
import { LanguageSelect, useI18n } from '@/i18n'
import { Badge, Btn } from './ui'

export function Header({ state, onSignOut }: { state: AgentState; onSignOut: () => void }) {
  const { t } = useI18n()
  const pause = useAction<{ paused: boolean }>('/control/pause')
  const panic = useAction<{ cancelOffers: boolean }>('/control/panic', 'POST', t('toast.stopped'))
  const [confirmPanic, setConfirmPanic] = useState(false)
  const live = state.mode === 'testnet-live'
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[rgba(13,27,47,0.85)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3 md:px-6">
        <div className="me-auto min-w-0">
          <h1 className="display truncate text-lg font-semibold">{t('app.title')}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--subtle)]">
            <Badge tone={live ? 'warn' : 'accent'}>{live ? t('mode.live') : t('mode.paper')}</Badge>
            <Badge tone={state.approvalMode === 'auto' ? 'warn' : 'neutral'}>{state.approvalMode === 'auto' ? t('approval.auto') : t('approval.manual')}</Badge>
            <span>{state.chain.name}</span>
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${state.paused ? 'bg-[var(--danger)]' : 'bg-[var(--success)]'}`} aria-hidden />
              {state.paused ? t('state.paused') : t('state.running')}
            </span>
          </div>
        </div>

        <LanguageSelect />
        <ConnectKitButton showBalance={false} />
        <Btn variant={state.paused ? 'primary' : 'ghost'} busy={pause.isPending} onClick={() => pause.mutate({ paused: !state.paused })}>
          {state.paused ? <Play size={16} aria-hidden /> : <Pause size={16} aria-hidden />}
          {state.paused ? t('btn.resume') : t('btn.pause')}
        </Btn>
        {confirmPanic ? (
          <div className="flex items-center gap-2">
            <Btn variant="danger" busy={panic.isPending} onClick={() => { panic.mutate({ cancelOffers: true }); setConfirmPanic(false) }}>
              {t('btn.stopConfirm')}
            </Btn>
            <Btn onClick={() => setConfirmPanic(false)}>{t('btn.cancel')}</Btn>
          </div>
        ) : (
          <Btn aria-label={t('btn.emergency')} onClick={() => setConfirmPanic(true)}>
            <OctagonAlert size={16} aria-hidden /> {t('btn.emergency')}
          </Btn>
        )}
        <button type="button" onClick={onSignOut} className="min-h-11 px-2 text-xs text-[var(--subtle)] hover:text-[var(--ink)]">{t('btn.signOut')}</button>
      </div>
    </header>
  )
}
