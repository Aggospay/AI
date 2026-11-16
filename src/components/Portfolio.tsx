import type { OrdersView, Portfolio as PortfolioT } from '@/lib/api'
import { ago, bpsPct, pnlClass, short, signedUsdc, until, usdc } from '@/lib/format'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'
import { Badge, Card, Empty, Table, Td } from './ui'

const REC_TONE = { hold: 'neutral', list: 'accent', reprice: 'warn', sell: 'good', delist: 'bad' } as const
const REC_LABEL = { hold: 'rec.hold', list: 'rec.list', reprice: 'rec.reprice', sell: 'rec.sell', delist: 'rec.delist' } as const satisfies Record<string, MessageKey>

export function Positions({ portfolio }: { portfolio?: PortfolioT }) {
  const { t, td } = useI18n()
  const rows = portfolio?.holdings ?? []
  return (
    <div className="space-y-5">
      <Card title={t('pf.holdings')}>
        {rows.length === 0 ? (
          <Empty>{t('pf.empty')}</Empty>
        ) : (
          <Table head={[t('pf.h.token'), t('pf.h.cost'), t('pf.h.ask'), t('pf.h.min'), t('pf.h.rival'), t('pf.h.net'), t('pf.h.unreal'), t('pf.h.decision')]}>
            {rows.map((h) => (
              <tr key={`${h.collection}-${h.tokenId}`}>
                <Td>{h.collectionName} #{h.tokenId}<div className="text-xs text-[var(--subtle)]">{td(`src.${h.source}`, h.source)}, {ago(h.acquiredTs)}</div></Td>
                <Td>{usdc(h.acquiredCost)}</Td>
                <Td>{h.listingPrice ? usdc(h.listingPrice) : <span className="text-[var(--subtle)]">{t('pf.notListed')}</span>}{h.listingExpiry ? <div className="text-xs text-[var(--subtle)]">{t('pf.expires', { t: until(h.listingExpiry) })}</div> : null}</Td>
                <Td>{usdc(h.minProfitablePrice)}</Td>
                <Td>{usdc(h.lowestCompetitor)}</Td>
                <Td>{usdc(h.markNet)}</Td>
                <Td className={pnlClass(h.unrealized)}>{signedUsdc(h.unrealized)}</Td>
                <Td><Badge tone={REC_TONE[h.recommendation]}>{t(REC_LABEL[h.recommendation])}</Badge><div className="mt-1 max-w-[220px] text-xs text-[var(--subtle)]">{h.reason}</div></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title={t('pf.exposure')}>
        {(portfolio?.exposure ?? []).length === 0 ? <Empty>{t('pf.noExposure')}</Empty> : (
          <ul className="space-y-3">
            {portfolio?.exposure.map((e) => (
              <li key={e.collection}>
                <div className="flex justify-between gap-3 text-sm"><span>{e.name} <span className="text-[var(--subtle)]">{short(e.collection)}</span></span><span className="num">{usdc(BigInt(e.positionCost) + BigInt(e.offerCapital), 2)} USDC, {bpsPct(e.shareBps)}</span></div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]"><div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, e.shareBps / 100)}%` }} /></div>
                <div className="mt-1 text-xs text-[var(--subtle)]">{t('pf.tokensHeld', { n: e.tokens, v: usdc(e.offerCapital, 2) })}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export function Orders() {
  const { t } = useI18n()
  const listings = useApi<OrdersView['listings']>('orders', '/listings', 4000)
  const offers = useApi<OrdersView['offers']>('orders-offers', '/offers', 4000)
  const mine = listings.data?.mine ?? []
  const market = listings.data?.market ?? []
  return (
    <div className="space-y-5">
      <Card title={t('or.listings')}>
        {market.length === 0 ? <Empty>{t('or.noListings')}</Empty> : (
          <Table head={[t('or.h.token'), t('or.h.seller'), t('or.h.price'), t('or.h.expires'), t('or.h.owner')]}>
            {market.map((l) => (
              <tr key={`${l.collection}-${l.token_id}`}>
                <Td>#{l.token_id} <span className="text-[var(--subtle)]">{short(l.collection)}</span></Td>
                <Td className="mono text-xs">{short(l.seller)}</Td>
                <Td className="font-semibold">{usdc(l.price)}</Td>
                <Td>{l.expiry ? until(l.expiry) : t('or.none')}</Td>
                <Td>{l.own ? <Badge tone="accent">{t('or.agent')}</Badge> : <Badge>{t('or.market')}</Badge>}</Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-[var(--subtle)]">{t('or.mine', { n: mine.length })}</p>
      </Card>
      <Card title={t('or.offers')}>
        <h3 className="label mb-2">{t('or.agentOffers')}</h3>
        {(offers.data?.mine ?? []).length === 0 ? <Empty>{t('or.noAgentOffers')}</Empty> : (
          <Table head={[t('or.h.scope'), t('or.h.collection'), t('or.h.bid'), t('or.h.expires')]}>
            {offers.data?.mine.map((o) => (
              <tr key={o.offerId}>
                <Td>{o.collectionWide ? <Badge tone="accent">{t('or.collWide')}</Badge> : <Badge>{t('or.token', { id: o.tokenId })}</Badge>}</Td>
                <Td className="mono text-xs">{short(o.collection)}</Td>
                <Td className="font-semibold">{usdc(o.price)}</Td>
                <Td>{until(o.expiry)}</Td>
              </tr>
            ))}
          </Table>
        )}
        <h3 className="label mb-2 mt-6">{t('or.competing')}</h3>
        {(offers.data?.market ?? []).length === 0 ? <Empty>{t('or.noCompeting')}</Empty> : (
          <Table head={[t('or.h.scope'), t('or.h.bidder'), t('or.h.bid'), t('or.h.expires')]}>
            {offers.data?.market.map((o) => (
              <tr key={o.offerId}>
                <Td>{o.collectionWide ? <Badge tone="accent">{t('or.collWide')}</Badge> : <Badge>{t('or.token', { id: o.tokenId })}</Badge>}</Td>
                <Td className="mono text-xs">{short(o.bidder)} {o.bidderRole === 'fixture' && <Badge tone="warn">{t('or.simulated')}</Badge>}</Td>
                <Td className="font-semibold">{usdc(o.price)}</Td>
                <Td>{until(o.expiry)}</Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-[var(--subtle)]">{t('or.noTrait')}</p>
      </Card>
    </div>
  )
}
