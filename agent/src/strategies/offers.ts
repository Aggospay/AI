/**
 * Offer and bid management (collection-wide offers; token offers share the same decision function).
 *
 * The ceiling for every bid is derived from the profit engine: the highest price at which the
 * expected resale still clears the minimum net profit and ROI after fees, royalties and gas. The agent
 * counters a rival by the smallest sensible increment, never exceeds that ceiling, lowers its own bid when
 * competition fades, cancels when it cannot win without overpaying, renews before expiry, never bids against
 * itself, and keeps committed capital within limits.
 */
import { feesFor } from '../analysis/fees'
import { activeOffers, agentAddress, collectionStats, type CollectionStats } from '../analysis/market'
import { maxAcquisitionPrice } from '../analysis/profit'
import { scoreCollection } from '../analysis/scoring'
import { PRICE_TICK, type Settings } from '../config'
import { listIntents } from '../exec/intents'
import type { Action } from '../types'
import { floorToTick, lc, minBig, nowSec } from '../util'
import { ensureUsdcAllowance } from './allowance'
import { shortName } from './buyer'
import { buildRisk, eligibleCollections, type Ctx } from './ctx'
import { realisticResale } from './pricing'

export type OfferDecisionKind = 'make' | 'raise' | 'lower' | 'renew' | 'cancel' | 'hold'

export interface OfferDecision {
  kind: OfferDecisionKind
  price: bigint
  reason: string
}

export interface OfferDecideInput {
  now: number
  maxBid: bigint
  rivalBest: bigint | null
  openingBid: bigint
  own: { offerId: number; price: bigint; expiry: number } | null
  lastActionTs: number | null
  offers: Settings['offers']
}

export function decideOffer(i: OfferDecideInput): OfferDecision {
  const tick = PRICE_TICK
  const inc = tick * BigInt(i.offers.incrementTicks)
  const cooling = i.lastActionTs !== null && i.now - i.lastActionTs < i.offers.cooldownSec

  if (i.maxBid <= 0n) {
    return i.own ? { kind: 'cancel', price: 0n, reason: 'no price is profitable any more' } : { kind: 'hold', price: 0n, reason: 'no profitable bid exists' }
  }
  if (i.rivalBest !== null && i.rivalBest >= i.maxBid) {
    return i.own
      ? { kind: 'cancel', price: 0n, reason: 'outbid beyond our maximum profitable price: freeing capital' }
      : { kind: 'hold', price: 0n, reason: 'rival bid is above our maximum profitable price' }
  }
  const desired = floorToTick(minBig(i.rivalBest !== null ? i.rivalBest + inc : i.openingBid, i.maxBid), tick)
  if (desired <= 0n) return { kind: 'hold', price: 0n, reason: 'no valid bid price' }

  if (!i.own) return { kind: 'make', price: desired, reason: i.rivalBest !== null ? 'counter the best rival offer by one increment' : 'opening bid below fair value' }

  // Own bid above the ceiling (costs or value moved): lower immediately.
  if (i.own.price > i.maxBid) return { kind: 'lower', price: minBig(desired, i.maxBid), reason: 'own bid exceeds the maximum profitable price' }

  const expiring = i.own.expiry - i.now < i.offers.renewBeforeSec
  if (i.own.price < desired && i.rivalBest !== null && i.rivalBest >= i.own.price) {
    // A rival matches or beats us: raise by the smallest step that wins. With no rival bid we never drift
    // up towards the ceiling on our own: a higher bid would only pay more for the same tokens.
    if (cooling) return { kind: 'hold', price: i.own.price, reason: 'cooldown active' }
    return { kind: 'raise', price: desired, reason: 'rival outbid us: smallest winning increment' }
  }
  if (i.own.price - desired >= tick * 2n) {
    if (cooling) return { kind: 'hold', price: i.own.price, reason: 'cooldown active' }
    return { kind: 'lower', price: desired, reason: 'competition decreased: reduce the bid' }
  }
  if (expiring) return { kind: 'renew', price: i.own.price, reason: 'offer is about to expire' }
  return { kind: 'hold', price: i.own.price, reason: 'already the best competitive bid within limits' }
}

function openIntent(ctx: Ctx, collection: string): boolean {
  return listIntents(ctx.db, ['approved', 'pending', 'submitted'], 200).some(
    (i) => ['makeOffer', 'updateOffer', 'cancelOffer'].includes(i.kind) && i.collection === lc(collection),
  )
}

function lastOfferActionTs(ctx: Ctx, collection: string): number | null {
  const r = ctx.db
    .query("SELECT MAX(updated_ts) AS t FROM intents WHERE collection = ? AND kind IN ('makeOffer','updateOffer','cancelOffer') AND status IN ('confirmed','submitted','pending')")
    .get(lc(collection)) as { t: number | null }
  return r.t ? Math.floor(r.t / 1000) : null
}

export async function runOffers(ctx: Ctx): Promise<void> {
  const s = ctx.getSettings()
  if (s.paused || !s.strategies.offers || !ctx.env.market) return
  const now = nowSec()
  const agent = agentAddress(ctx.db)
  if (!agent) return
  const own = ctx.own.offers().filter((o) => o.collectionWide)
  let gasMake: bigint
  let gasSellSide: bigint
  try {
    gasMake = ctx.gas.costUsdc('makeOffer')
    gasSellSide = ctx.gas.costUsdc('approveCollection') + ctx.gas.costUsdc('list') + ctx.gas.costUsdc('updateListing', 2)
  } catch {
    return
  }
  const targets = s.offers.targets.map(lc)
  const collections = eligibleCollections(ctx).filter((c) => (targets.length === 0 ? true : targets.includes(c.address)))

  for (const c of collections) {
    const mine = own.find((o) => lc(o.collection) === c.address) ?? null
    if (openIntent(ctx, c.address)) continue
    const stats: CollectionStats = collectionStats(ctx.db, c.address, s, now)
    const tokens = ctx.db.query('SELECT COUNT(*) AS n FROM tokens WHERE collection = ? AND traits IS NOT NULL').get(c.address) as { n: number }
    const score = scoreCollection(c, stats, tokens.n)

    // A collection with no reliable value gets no bids; an existing bid is withdrawn.
    let maxBid = 0n
    let opening = 0n
    if (stats.fairValue !== null && stats.confidence >= 0.2) {
      const resale = realisticResale(stats.fairValue, stats.floor, s.pricing.undercutTicks)
      if (resale !== null) {
        maxBid = maxAcquisitionPrice({
          expectedResalePrice: resale, fees: feesFor(ctx.db, c.address),
          gasTotal: gasMake + gasSellSide, other: s.risk.otherCostsPerTrade,
          minNetProfit: s.risk.minNetProfit, minRoiBps: BigInt(s.risk.minRoiBps),
          haircutBps: BigInt(s.pricing.resaleHaircutBps), ceiling: s.risk.maxPurchasePrice,
        })
        opening = floorToTick((stats.fairValue * 85n) / 100n, PRICE_TICK)
      }
    }

    const rival = activeOffers(ctx.db, now, c.address)
      .filter((o) => o.collectionWide && lc(o.bidder) !== agent)
      .reduce<bigint | null>((m, o) => (m === null || o.price > m ? o.price : m), null)

    const d = decideOffer({
      now, maxBid, rivalBest: rival, openingBid: opening,
      own: mine ? { offerId: mine.offerId, price: mine.price, expiry: mine.expiry } : null,
      lastActionTs: lastOfferActionTs(ctx, c.address), offers: s.offers,
    })
    if (d.kind === 'hold') continue

    const name = shortName(ctx, c.address)
    const expiry = (now + s.offers.durationSec).toString()
    let action: Action
    if (d.kind === 'cancel' && mine) {
      action = {
        key: `cancelOffer:${mine.offerId}:${Math.floor(now / 60)}`, kind: 'cancelOffer', strategy: 'offers', collection: c.address,
        params: { offerId: String(mine.offerId) }, spend: 0n, gasEstimate: ctx.gas.costUsdc('cancelOffer'),
        summary: `Cancel offer on ${name}: ${d.reason}`,
      }
    } else if (d.kind === 'make') {
      if (own.length >= s.offers.maxOpenOffers) continue
      const cap = await ctx.own.capital()
      if (cap.available < d.price) continue
      if (!(await ensureUsdcAllowance(ctx, d.price, 'offers'))) continue
      action = {
        key: `makeOffer:${c.address}:${d.price}:${Math.floor(now / 30)}`, kind: 'makeOffer', strategy: 'offers', collection: c.address,
        params: { collection: c.address, tokenId: '0', collectionWide: true, price: d.price.toString(), expiry },
        spend: d.price, gasEstimate: gasMake,
        summary: `Bid ${(Number(d.price) / 1e6).toFixed(3)} USDC on any ${name} (${d.reason})`,
        analysis: { maxBid, rivalBest: rival, reason: d.reason },
      }
    } else if (mine) {
      const delta = d.price > mine.price ? d.price - mine.price : 0n
      if (delta > 0n) {
        const cap = await ctx.own.capital()
        if (cap.available < delta) continue
        if (!(await ensureUsdcAllowance(ctx, delta, 'offers'))) continue
      }
      action = {
        key: `updateOffer:${mine.offerId}:${d.price}:${Math.floor(now / 30)}`, kind: 'updateOffer', strategy: 'offers', collection: c.address,
        params: { offerId: String(mine.offerId), price: d.price.toString(), expiry },
        spend: delta, gasEstimate: ctx.gas.costUsdc('updateOffer'),
        summary: `${d.kind === 'renew' ? 'Renew' : d.kind === 'raise' ? 'Raise' : 'Lower'} bid on ${name} to ${(Number(d.price) / 1e6).toFixed(3)} USDC (${d.reason})`,
        analysis: { maxBid, rivalBest: rival, reason: d.reason },
      }
    } else continue

    const unit = action.kind === 'makeOffer' || action.kind === 'updateOffer' ? d.price : undefined
    const gross = maxBid > 0n && unit !== undefined
    const risk = await buildRisk(ctx, action, {
      stats, score, collection: c, gasCost: action.gasEstimate, unitPrice: unit,
      fairValue: stats.fairValue, fairValueConfidence: stats.confidence,
      analysis: gross ? { ok: d.price <= maxBid, netProfit: maxBid - d.price, roiBps: 0n, reasons: ['bid above the maximum profitable price'] } : null,
    })
    await ctx.exec.submit(action, risk)
  }
}
