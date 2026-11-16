import { AlertTriangle, Info, OctagonAlert } from 'lucide-react'
import { buildTxExplorerUrl } from '@/onchain-facts'
import type { AgentState, CollectionView, IntentView, Opportunity, Portfolio } from '@/lib/api'
import { ago, bpsPct, pnlClass, short, signedUsdc, until, usdc } from '@/lib/format'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/i18n'
import { Badge, Card, Empty, Stat } from './ui'

function Alerts({ state }: { state: AgentState }) {
  const { t, td } = useI18n()
  if (state.alerts.length === 0) return <p className="text-sm text-[var(--subtle)]">{t('ov.noAlerts')}</p>
  return (
    <ul className="space-y-2">
      {state.alerts.map((a) => (
        <li key={a.code} className="flex items-start gap-2.5 text-sm">
          {a.level === 'error' ? <OctagonAlert size={16} className="mt-0.5 shrink-0 text-[var(--danger)]" aria-hidden /> : a.level === 'warn' ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--warn)]" aria-hidden /> : <Info size={16} className="mt-0.5 shrink-0 text-[var(--subtle)]" aria-hidden />}
          <span className="text-[var(--ink-2)]">{td(`alert.${a.code}`, a.message, a.params)}</span>
        </li>
      ))}
    </ul>
  )
}

export function Overview({ state, portfolio }: { state: AgentState; portfolio?: Portfolio }) {
  const { t, td } = useI18n()
  const intents = useApi<IntentView[]>('intents', '/intents')
  const opps = useApi<Opportunity[]>('opportunities', '/opportunities', 6000)
  const cols = useApi<CollectionView[]>('collections', '/collections', 8000)
  const p = portfolio
  const recent = (intents.data ?? []).filter((i) => ['confirmed', 'failed', 'submitted', 'pending'].includes(i.status)).slice(0, 8)
  const failed = (intents.data ?? []).filter((i) => i.status === 'failed').slice(0, 5)
  const launches = (cols.data ?? []).filter((c) => c.phase === 'upcoming' || c.phase === 'live')
  const best = (opps.data ?? []).filter((o) => o.profit.ok).slice(0, 5)
  const active = (intents.data ?? []).filter((i) => ['approved', 'pending', 'submitted'].includes(i.status))
  const paper = state.mode === 'paper'

  return (
    <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
      <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
        <Card>
          <Stat
            label={paper ? t('ov.paperValue') : t('ov.value')}
            value={`${usdc(p?.totalValue, 2)} USDC`}
            sub={paper ? t('ov.paperValueSub') : t('ov.valueSub')}
          />
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
            <Stat label={t('ov.available')} value={usdc(p?.capital.available, 2)} sub="USDC" />
            <Stat label={t('ov.inOffers')} value={usdc(p?.capital.committedToOffers, 2)} sub={t('ov.escrowed')} />
            <Stat label={t('ov.realized')} value={signedUsdc(p?.realized, 2)} tone={pnlClass(p?.realized)} sub={t('ov.sub24h', { v: signedUsdc(p?.realizedDay, 2) })} />
            <Stat label={t('ov.unrealized')} value={signedUsdc(p?.unrealized, 2)} tone={pnlClass(p?.unrealized)} sub={t('ov.sub7d', { v: signedUsdc(p?.realizedWeek, 2) })} />
            <Stat label={t('ov.gas')} value={usdc(p?.gasTotal, 3)} sub="USDC" />
            <Stat label={t('ov.fees')} value={usdc(p?.feesPaid, 3)} sub={t('ov.feesSub')} />
          </dl>
        </Card>
        <Card title={t('ov.alerts')}><Alerts state={state} /></Card>
        <Card title={t('ov.health')}>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-[var(--subtle)]">{t('ov.lag')}</dt><dd className="num">{state.indexer.lagBlocks === null ? '-' : t('ov.blocks', { n: state.indexer.lagBlocks })}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[var(--subtle)]">{t('ov.lastSync')}</dt><dd className="num">{ago(state.indexer.lastSyncTs)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[var(--subtle)]">{t('ov.headFeed')}</dt><dd>{state.indexer.wsConnected ? t('ov.ws') : t('ov.polling')}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[var(--subtle)]">{t('ov.rpc')}</dt><dd className="num">{t('ov.rpcUp', { up: state.providers.providers.filter((x) => x.ok).length, total: state.providers.providers.length })}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[var(--subtle)]">{t('ov.fee')}</dt><dd className="num">{bpsPct(state.marketFeeBps)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-[var(--subtle)]">{t('ov.uptime')}</dt><dd className="num">{t('ov.minutes', { n: Math.floor(state.uptimeSec / 60) })}</dd></div>
          </dl>
        </Card>
      </aside>

      <div className="space-y-5">
        <div className="grid gap-5 md:grid-cols-4">
          {[
            [t('ov.openPositions'), p?.counts.open ?? 0],
            [t('ov.activeListings'), p?.counts.listings ?? 0],
            [t('ov.activeOffers'), p?.counts.offers ?? 0],
            [t('ov.inflight'), active.length],
          ].map(([label, v]) => (
            <Card key={String(label)}><Stat label={String(label)} value={String(v)} /></Card>
          ))}
        </div>

        <Card title={t('ov.best')} aside={<Badge tone="neutral">{t('ov.qualify', { n: best.length })}</Badge>}>
          {best.length === 0 ? (
            <Empty>{t('ov.noBest')}</Empty>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {best.map((o) => (
                <li key={`${o.collection}${o.tokenId}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate">#{o.tokenId} <span className="text-[var(--subtle)]">{short(o.collection)}</span></span>
                  <span className="num shrink-0">{usdc(o.price)} <span className="text-[var(--subtle)]">{t('ov.to')}</span> {usdc(o.expectedResale)}</span>
                  <span className={`num shrink-0 font-semibold ${pnlClass(o.profit.netProfit)}`}>{signedUsdc(o.profit.netProfit)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="grid gap-5 xl:grid-cols-2">
          <Card title={t('ov.launches')}>
            {launches.length === 0 ? <Empty>{t('ov.noLaunches')}</Empty> : (
              <ul className="divide-y divide-[var(--border)]">
                {launches.map((c) => (
                  <li key={c.address} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0 truncate">{c.name} <span className="text-[var(--subtle)]">{c.totalMinted}/{c.maxSupply}</span></span>
                    <Badge tone={c.phase === 'live' ? 'good' : 'accent'}>{c.phase === 'live' ? t('ov.liveEnds', { t: until(c.mintEnd) }) : t('ov.opensIn', { t: until(c.mintStart) })}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('ov.floors')}>
            {(cols.data ?? []).length === 0 ? <Empty>{t('ov.noCollections')}</Empty> : (
              <ul className="divide-y divide-[var(--border)]">
                {(cols.data ?? []).slice(0, 6).map((c) => (
                  <li key={c.address} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="num shrink-0">{c.stats.floor ? t('ov.floor', { v: usdc(c.stats.floor) }) : t('ov.noListings')}</span>
                    <span className="num shrink-0 text-[var(--subtle)]">{t('ov.score', { n: c.score.score.toFixed(0) })}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title={t('ov.recent')}>
          {recent.length === 0 ? <Empty>{t('ov.noTx')}</Empty> : (
            <ul className="divide-y divide-[var(--border)]">
              {recent.map((i) => (
                <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{i.summary}</span>
                  <Badge tone={i.status === 'confirmed' ? 'good' : i.status === 'failed' ? 'bad' : 'warn'}>{td(`status.${i.status}`, i.status)}</Badge>
                  {i.txHash && !i.txHash.startsWith('paper:') ? (
                    <a className="mono text-xs text-[var(--accent)] underline" href={buildTxExplorerUrl(state.chain.id, i.txHash)} target="_blank" rel="noopener noreferrer">{short(i.txHash)}</a>
                  ) : (
                    <span className="text-xs text-[var(--subtle)]">{i.mode === 'paper' ? t('ov.simulated') : ago(i.updatedTs)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {failed.length > 0 && (
          <Card title={t('ov.failed')}>
            <ul className="space-y-2 text-sm">
              {failed.map((i) => (
                <li key={i.key}><span className="text-[var(--ink-2)]">{i.summary}</span> <span className="text-[var(--danger)]">{i.error}</span></li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  )
}
