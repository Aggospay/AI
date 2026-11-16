import { useState } from 'react'
import type { AgentState } from '@/lib/api'
import { useAction } from '@/lib/hooks'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'
import { Badge, Btn, Card, inputCls, Toggle } from './ui'

const STRATEGIES: Array<{ id: 'mint' | 'buy' | 'list' | 'offers'; label: MessageKey; hint: MessageKey }> = [
  { id: 'mint', label: 'ct.mint.l', hint: 'ct.mint.h' },
  { id: 'buy', label: 'ct.buy.l', hint: 'ct.buy.h' },
  { id: 'list', label: 'ct.list.l', hint: 'ct.list.h' },
  { id: 'offers', label: 'ct.offers.l', hint: 'ct.offers.h' },
]
const CONFIRM_PHRASE = 'ENABLE TESTNET TRADING'

export function Controls({ state }: { state: AgentState }) {
  const { t } = useI18n()
  const strategy = useAction<{ name: string; enabled: boolean }>('/control/strategy')
  const approval = useAction<{ mode: 'manual' | 'auto' }>('/control/approval-mode')
  const mode = useAction<{ mode: 'paper' | 'testnet-live'; confirm?: string }>('/control/mode', 'POST', t('ct.modeToast'))
  const [confirm, setConfirm] = useState('')
  const live = state.mode === 'testnet-live'
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title={t('ct.strategies')}>
        <ul className="divide-y divide-[var(--border)]">
          {STRATEGIES.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0"><div className="text-sm font-medium">{t(s.label)}</div><div className="text-xs text-[var(--subtle)]">{t(s.hint)}</div></div>
              <Toggle label={t(s.label)} checked={state.strategies[s.id]} onChange={(enabled) => strategy.mutate({ name: s.id, enabled })} />
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t('ct.approval')}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('ct.approval')}>
          {(['manual', 'auto'] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={state.approvalMode === m}
              onClick={() => approval.mutate({ mode: m })}
              className={`min-h-11 rounded-xl border px-3 text-sm font-semibold ${state.approvalMode === m ? 'border-[var(--accent)] bg-[rgba(172,198,233,0.14)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--muted)]'}`}
            >
              {m === 'manual' ? t('approval.manual') : t('approval.auto')}
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm text-[var(--subtle)]">
          {t('ct.approvalDesc')}
        </p>
      </Card>

      <Card title={t('ct.mode')} className="lg:col-span-2">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={live ? 'warn' : 'accent'}>{live ? t('ct.liveBadge') : t('ct.paperBadge')}</Badge>
          {!state.live.ready && <span className="text-sm text-[var(--warn)]">{t('ct.liveUnavailable', { r: state.live.reason })}</span>}
        </div>
        {live ? (
          <Btn className="mt-4" busy={mode.isPending} onClick={() => mode.mutate({ mode: 'paper' })}>{t('ct.backPaper')}</Btn>
        ) : (
          <div className="mt-4 max-w-xl">
            <p className="text-sm text-[var(--ink-2)]">
              {t('ct.liveDesc')}
            </p>
            <label className="mt-3 block text-sm">
              <span className="text-[var(--ink-2)]">{t('ct.confirmPrompt')}</span>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} dir="ltr" className={`${inputCls} mt-1 mono`} placeholder={CONFIRM_PHRASE} />
            </label>
            <Btn variant="primary" className="mt-3" disabled={confirm !== CONFIRM_PHRASE || !state.live.ready} busy={mode.isPending} onClick={() => mode.mutate({ mode: 'testnet-live', confirm })}>
              {t('ct.enable')}
            </Btn>
          </div>
        )}
      </Card>
    </div>
  )
}
