import { buildTxExplorerUrl } from '@/onchain-facts'
import type { ActivityRow, AgentState, IntentView } from '@/lib/api'
import { ago, minutesLeft, short, usdc } from '@/lib/format'
import { useAction, useApi } from '@/lib/hooks'
import { useI18n } from '@/i18n'
import { Badge, Btn, Card, Empty } from './ui'

export function Approvals({ state }: { state: AgentState }) {
  const { t, td } = useI18n()
  const intents = useApi<IntentView[]>('intents', '/intents?status=proposed', 3000)
  const approve = useAction<string>((k) => `/intents/${encodeURIComponent(k)}/approve`, 'POST', t('ap.approved'))
  const reject = useAction<string>((k) => `/intents/${encodeURIComponent(k)}/reject`, 'POST', t('ap.rejected'))
  const rows = intents.data ?? []
  return (
    <Card title={t('ap.title')} aside={<Badge tone={state.approvalMode === 'manual' ? 'accent' : 'warn'}>{state.approvalMode === 'manual' ? t('ap.manual') : t('ap.auto')}</Badge>}>
      {rows.length === 0 ? (
        <Empty>{t('ap.empty')}</Empty>
      ) : (
        <ul className="space-y-3">
          {rows.map((i) => (
            <li key={i.key} className="rounded-xl border border-[var(--border)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><Badge tone="accent">{td(`kind.${i.kind}`, i.kind)}</Badge><span className="text-xs text-[var(--subtle)]">{i.expiresTs ? t('ap.left', { ago: ago(i.createdTs), n: minutesLeft(i.expiresTs) }) : ago(i.createdTs)}</span></div>
                  <p className="mt-1.5 text-sm text-[var(--ink)]">{i.summary}</p>
                  <p className="num mt-1 text-xs text-[var(--subtle)]">{t('ap.spend', { a: usdc(i.spend), g: usdc(i.estCost) })}{i.analysis && 'netProfit' in i.analysis ? t('ap.net', { v: usdc(String(i.analysis.netProfit)) }) : ''}</p>
                </div>
                <div className="flex gap-2">
                  <Btn variant="primary" busy={approve.isPending} onClick={() => approve.mutate(i.key)}>{t('ap.approve')}</Btn>
                  <Btn busy={reject.isPending} onClick={() => reject.mutate(i.key)}>{t('ap.reject')}</Btn>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

const LEVEL_TONE = { info: 'neutral', warn: 'warn', error: 'bad' } as const

export function ActivityLog({ state }: { state: AgentState }) {
  const { t, td } = useI18n()
  const log = useApi<ActivityRow[]>('activity', '/activity?limit=150', 4000)
  const intents = useApi<IntentView[]>('intents', '/intents', 5000)
  const failed = (intents.data ?? []).filter((i) => i.status === 'failed' || i.status === 'rejected')
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <Card title={t('act.title')}>
        <p className="mb-3 text-xs text-[var(--subtle)]">{t('lang.note')}</p>
        {(log.data ?? []).length === 0 ? <Empty>{t('act.empty')}</Empty> : (
          <ul className="divide-y divide-[var(--border)]">
            {log.data?.map((a) => (
              <li key={a.id} className="flex items-start gap-3 py-2.5 text-sm">
                <span className="num w-16 shrink-0 text-xs text-[var(--subtle)]">{ago(a.ts)}</span>
                <Badge tone={LEVEL_TONE[a.level]}>{td(`strategy.${a.strategy}`, a.strategy)}</Badge>
                <span className="min-w-0 flex-1 text-[var(--ink-2)]">{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="space-y-5">
        <Card title={t('act.failedTitle')}>
          {failed.length === 0 ? <Empty>{t('act.none')}</Empty> : (
            <ul className="space-y-3 text-sm">
              {failed.slice(0, 15).map((i) => (
                <li key={i.key}>
                  <div className="text-[var(--ink-2)]">{i.summary}</div>
                  <div className="text-xs text-[var(--danger)]">{i.error}</div>
                  {i.txHash && !i.txHash.startsWith('paper:') && <a className="mono text-xs text-[var(--accent)] underline" href={buildTxExplorerUrl(state.chain.id, i.txHash)} target="_blank" rel="noopener noreferrer">{short(i.txHash)}</a>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t('act.tasks')}>
          <ul className="space-y-1.5 text-xs">
            {state.tasks.map((tk) => (
              <li key={tk.name} className="flex items-center justify-between gap-2">
                <span className="mono">{tk.name}</span>
                <span className={tk.lastStatus === 'error' ? 'text-[var(--danger)]' : 'text-[var(--subtle)]'}>{tk.lastStatus === 'error' ? tk.lastError?.slice(0, 40) : t('act.runs', { n: tk.runs, ago: ago(tk.lastRun) })}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
