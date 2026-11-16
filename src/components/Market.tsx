import { useState } from 'react'
import type { CollectionView, Opportunity } from '@/lib/api'
import { bpsPct, pnlClass, short, signedUsdc, until, usdc } from '@/lib/format'
import { useAction, useApi } from '@/lib/hooks'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'
import { Badge, Btn, Card, Empty, Table, Td } from './ui'

const TIER: MessageKey[] = ['tier.0', 'tier.1', 'tier.2', 'tier.3']

export function Opportunities() {
  const { t } = useI18n()
  const opps = useApi<Opportunity[]>('opportunities', '/opportunities', 5000)
  const rows = opps.data ?? []
  return (
    <Card title={t('opp.title')} aside={<span className="text-xs text-[var(--subtle)]">{t('opp.counts', { ok: rows.filter((r) => r.profit.ok).length, total: rows.length })}</span>}>
      {rows.length === 0 ? (
        <Empty>{t('opp.empty')}</Empty>
      ) : (
        <Table head={[t('opp.h.token'), t('opp.h.ask'), t('opp.h.fair'), t('opp.h.resale'), t('opp.h.fees'), t('opp.h.net'), t('opp.h.roi'), t('opp.h.score'), t('opp.h.verdict')]}>
          {rows.map((o) => (
            <tr key={`${o.collection}-${o.tokenId}`}>
              <Td>#{o.tokenId} <span className="text-[var(--subtle)]">{short(o.collection)}</span><div className="text-xs text-[var(--subtle)]">{o.tier === 99 ? t('tier.unknown') : t(TIER[o.tier])}</div></Td>
              <Td>{usdc(o.price)}</Td>
              <Td>{usdc(o.fairValue)}<div className="text-xs text-[var(--subtle)]">{t('opp.conf', { n: (o.confidence * 100).toFixed(0) })}</div></Td>
              <Td>{usdc(o.expectedResale)}</Td>
              <Td>{usdc(BigInt(o.profit.marketFee) + BigInt(o.profit.royalty))}</Td>
              <Td className={`font-semibold ${pnlClass(o.profit.netProfit)}`}>{signedUsdc(o.profit.netProfit)}</Td>
              <Td>{bpsPct(o.profit.roiBps)}</Td>
              <Td>{o.score.toFixed(0)}</Td>
              <Td>{o.profit.ok ? <Badge tone="good">{t('opp.qualifies')}</Badge> : <Badge tone="neutral">{o.profit.reasons[0] ?? t('opp.rejected')}</Badge>}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

function MintNow({ c }: { c: CollectionView }) {
  const { t } = useI18n()
  const [qty, setQty] = useState(1)
  const mint = useAction<{ collection: string; quantity: number }>('/mint', 'POST', t('mint.toast'))
  return (
    <div className="flex items-center gap-2">
      <input aria-label={t('mint.qty')} type="number" min={1} max={c.maxPerWallet} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value)))} className="num min-h-11 w-16 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] px-2 text-sm" />
      <Btn variant="primary" busy={mint.isPending} onClick={() => mint.mutate({ collection: c.address, quantity: qty })}>{t('mint.now')}</Btn>
    </div>
  )
}

export function Launches() {
  const { t } = useI18n()
  const cols = useApi<CollectionView[]>('collections', '/collections', 5000)
  const [open, setOpen] = useState<string | null>(null)
  const rows = cols.data ?? []
  return (
    <div className="space-y-5">
      <Card title={t('ln.title')}>
        {rows.length === 0 ? (
          <Empty>{t('ln.empty')}</Empty>
        ) : (
          <div className="space-y-3">
            {rows.map((c) => (
              <article key={c.address} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 me-auto">
                    <h3 className="display truncate text-lg font-semibold">{c.name} <span className="text-sm font-normal text-[var(--subtle)]">{c.symbol}</span></h3>
                    <p className="mono text-xs text-[var(--subtle)]">{short(c.address)}</p>
                  </div>
                  <Badge tone={c.phase === 'live' ? 'good' : c.phase === 'upcoming' ? 'accent' : 'neutral'}>
                    {c.phase === 'live' ? t('ln.live', { t: until(c.mintEnd) }) : c.phase === 'upcoming' ? t('ln.upcoming', { t: until(c.mintStart) }) : c.phase === 'soldout' ? t('ln.soldout') : t('ln.closed')}
                  </Badge>
                  <div className="text-end">
                    <div className="label">{t('ln.score')}</div>
                    <div className="display num text-xl font-semibold">{c.score.score.toFixed(0)}<span className="text-xs font-normal text-[var(--subtle)]"> {t('ln.assessed', { n: (c.score.coverage * 100).toFixed(0) })}</span></div>
                  </div>
                  {c.phase === 'live' && <MintNow c={c} />}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-6">
                  {[
                    [t('ln.mintPrice'), `${usdc(c.mintPrice)} USDC`],
                    [t('ln.minted'), `${c.totalMinted}/${c.maxSupply}`],
                    [t('ln.floor'), c.stats.floor ? usdc(c.stats.floor) : '-'],
                    [t('ln.fair'), c.stats.fairValue ? `${usdc(c.stats.fairValue)} (${(c.stats.confidence * 100).toFixed(0)}%)` : '-'],
                    [t('ln.sales'), t('ln.salesVal', { n: c.stats.salesCount, x: c.stats.excludedSales })],
                    [t('ln.holders'), t('ln.holdersVal', { n: c.stats.holders, p: bpsPct(c.stats.topHolderShareBps) })],
                  ].map(([k, v]) => (
                    <div key={k}><dt className="label">{k}</dt><dd className="num mt-0.5">{v}</dd></div>
                  ))}
                </dl>
                <button type="button" className="mt-3 min-h-11 text-xs text-[var(--accent)] underline" onClick={() => setOpen(open === c.address ? null : c.address)}>
                  {open === c.address ? t('ln.hide') : t('ln.show')}
                </button>
                {open === c.address && (
                  <ul className="mt-1 space-y-1.5 text-sm">
                    {c.score.components.map((s) => (
                      <li key={s.name} className="flex flex-wrap items-baseline justify-between gap-2">
                        <span>{s.name}</span>
                        <span className="num">{s.points === null ? <span className="text-[var(--subtle)]">{t('ln.unscored')}</span> : `${s.points} / ${s.max}`}</span>
                        <span className="w-full text-xs text-[var(--subtle)]">{s.note}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
