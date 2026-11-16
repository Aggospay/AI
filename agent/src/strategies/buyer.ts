/**
 * Scanner and buyer. Ranks every active listing by expected NET profit and buys only when every
 * gate passes. A cheap price alone never qualifies: the decision rests on realistic resale value,
 * liquidity, fees, royalties and gas, then on the risk engine. Every candidate is re-verified
 * against live chain state immediately before an order is created.
 */
import { formatUsdc } from '../../../src/onchain-money'
import { feesFor } from '../analysis/fees'
import {
  activeListings, agentAddress, collectionStats, tokenFairValue, walletRoles, type ListingRow,
} from '../analysis/market'
import { evaluateTrade, type ProfitResult } from '../analysis/profit'
import { scoreCollection } from '../analysis/scoring'
import { logActivity } from '../db'
import { readLiveListing, readUsdcAllowance } from '../chain/verify'
import { logger } from '../log'
import type { Action } from '../types'
import { errMessage, lc, nowSec } from '../util'
import { buildRisk, eligibleCollections, type Ctx } from './ctx'
import { comparablesFor, realisticResale, sellSideGas } from './pricing'

const log = logger('buyer')

export interface Opportunity {
  collection: string
  tokenId: string
  seller: string
  price: bigint
  tier: number
  fairValue: bigint
  expectedResale: bigint
  profit: ProfitResult
  score: number
  confidence: number
}

/** Pure-ish scan: returns ranked opportunities (profitable and not), without acting. */
export function scanOpportunities(ctx: Ctx): { ok: Opportunity[]; all: Opportunity[] } {
  const s = ctx.getSettings()
  const now = nowSec()
  const agent = agentAddress(ctx.db)
  const roles = walletRoles(ctx.db)
  const held = new Set(ctx.own.holdings().map((h) => `${lc(h.collection)}:${h.tokenId}`))
  const all: Opportunity[] = []
  let gasBuy: bigint
  let gasSell: bigint
  try {
    gasBuy = ctx.gas.costUsdc('buy')
    gasSell = sellSideGas(ctx)
  } catch {
    return { ok: [], all: [] } // no gas price yet: never guess
  }
  for (const c of eligibleCollections(ctx)) {
    if (c.totalMinted === 0) continue
    const stats = collectionStats(ctx.db, c.address, s, now)
    const tokens = ctx.db.query('SELECT COUNT(*) AS n FROM tokens WHERE collection = ? AND traits IS NOT NULL').get(c.address) as {
      n: number
    }
    const score = scoreCollection(c, stats, tokens.n)
    let fees
    try {
      fees = feesFor(ctx.db, c.address)
    } catch {
      continue
    }
    for (const l of activeListings(ctx.db, now, c.address)) {
      if (agent && lc(l.seller) === agent) continue
      if (held.has(`${l.collection}:${l.tokenId}`)) continue
      if (!s.risk.allowFixtureCounterparties && roles.get(lc(l.seller)) === 'fixture') continue
      const cmp = comparablesFor(ctx, c.address, l.tokenId, now, agent)
      const tfv = tokenFairValue(stats, cmp.rarity.get(l.tokenId))
      // Competitors after we buy: everyone comparable except this very listing.
      const others = cmp.competitors.filter((x) => x.tokenId !== l.tokenId)
      const lowestOther = others.reduce<ListingRow | null>((m, x) => (!m || x.price < m.price ? x : m), null)
      const resale = realisticResale(tfv.value, lowestOther?.price ?? null, s.pricing.undercutTicks)
      if (resale === null || tfv.value === null) continue
      const profit = evaluateTrade({
        costs: { acquisitionPrice: l.price, gasAcquire: gasBuy, gasSell, other: s.risk.otherCostsPerTrade },
        fees,
        expectedResalePrice: resale,
        haircutBps: BigInt(s.pricing.resaleHaircutBps),
        expectedHoldingSec: s.pricing.expectedHoldingSec,
        minNetProfit: s.risk.minNetProfit,
        minRoiBps: BigInt(s.risk.minRoiBps),
      })
      all.push({
        collection: c.address, tokenId: l.tokenId, seller: l.seller, price: l.price, tier: tfv.tier,
        fairValue: tfv.value, expectedResale: resale, profit, score: score.score, confidence: tfv.confidence,
      })
    }
  }
  all.sort((a, b) => (a.profit.netProfit > b.profit.netProfit ? -1 : a.profit.netProfit < b.profit.netProfit ? 1 : 0))
  return { ok: all.filter((o) => o.profit.ok), all }
}

export async function runBuyer(ctx: Ctx): Promise<void> {
  const s = ctx.getSettings()
  if (s.paused || !s.strategies.buy || !ctx.env.market) return
  const now = nowSec()
  const { ok } = scanOpportunities(ctx)
  let submitted = 0
  const gasBuy = ctx.gas.costUsdc('buy')

  for (const o of ok) {
    if (submitted >= 3) break
    const action: Action = {
      key: `buy:${o.collection}:${o.tokenId}:${o.price}`,
      kind: 'buy',
      strategy: 'buy',
      collection: o.collection,
      tokenId: o.tokenId,
      params: { collection: o.collection, tokenId: o.tokenId, maxPrice: o.price.toString() },
      spend: o.price,
      gasEstimate: gasBuy,
      summary: `Buy #${o.tokenId} of ${shortName(ctx, o.collection)} at ${fmt(o.price)} USDC (expected net ${fmt(o.profit.netProfit)})`,
      analysis: {
        netProfit: o.profit.netProfit, roiBps: o.profit.roiBps, expectedResale: o.expectedResale, fairValue: o.fairValue,
        marketFee: o.profit.marketFee, royalty: o.profit.royalty, totalCost: o.profit.totalCost, breakEven: o.profit.breakEvenPrice,
        holdingSec: o.profit.holdingSec, score: o.score,
      },
    }

    const c = ctx.db.query('SELECT 1 FROM collections WHERE address = ?').get(o.collection)
    if (!c) continue
    const stats = collectionStats(ctx.db, o.collection, s, now)
    const collection = eligibleCollections(ctx).find((x) => x.address === o.collection) ?? null
    const tokens = ctx.db.query('SELECT COUNT(*) AS n FROM tokens WHERE collection = ? AND traits IS NOT NULL').get(o.collection) as { n: number }
    const score = collection ? scoreCollection(collection, stats, tokens.n) : null

    // 1. Re-verify against live chain state: listing, owner and approval must still hold.
    if (!ctx.own.paper()) {
      try {
        const live = await readLiveListing(ctx.client, ctx.env.market, o.collection as `0x${string}`, BigInt(o.tokenId))
        if (!live || live.price !== o.price || !live.ownerIsSeller || !live.approved || (live.expiry !== 0 && live.expiry <= now)) {
          logActivity(ctx.db, { strategy: 'buy', message: `Skipped #${o.tokenId}: listing changed onchain since the last index`, data: { collection: o.collection } })
          continue
        }
      } catch (e) {
        log.warn('live verification failed', { error: errMessage(e) })
        continue
      }
      // 2. USDC allowance to the market, once, capped by the exposure limit.
      const agent = agentAddress(ctx.db)
      if (!agent) continue
      const allowance = await readUsdcAllowance(ctx.client, agent as `0x${string}`, ctx.env.market)
      if (allowance < o.price) {
        const approve: Action = {
          key: `approveUsdc:market:${s.risk.maxExposurePerCollection}:${allowance === 0n ? 'initial' : 'topup'}`,
          kind: 'approveUsdc', strategy: 'buy', params: { spender: ctx.env.market, amount: s.risk.maxExposurePerCollection.toString() },
          spend: 0n, gasEstimate: ctx.gas.costUsdc('approveUsdc'),
          summary: `Approve the market to spend up to ${fmt(s.risk.maxExposurePerCollection)} USDC`,
        }
        await ctx.exec.submit(approve, await buildRisk(ctx, approve))
        continue // buy on a later cycle once the allowance lands
      }
    }

    const risk = await buildRisk(ctx, action, {
      collection, stats, score, gasCost: gasBuy, fairValue: o.fairValue, fairValueConfidence: o.confidence,
      unitPrice: o.price, counterparty: o.seller,
      analysis: { ok: o.profit.ok, netProfit: o.profit.netProfit, roiBps: o.profit.roiBps, reasons: o.profit.reasons },
    })
    const res = await ctx.exec.submit(action, risk)
    if (res.status === 'running' || res.status === 'proposed') submitted++
  }
}

const fmt = (v: bigint): string => formatUsdc(v)
export const shortName = (ctx: Ctx, collection: string): string => {
  const r = ctx.db.query('SELECT name FROM collections WHERE address = ?').get(lc(collection)) as { name: string } | null
  return r?.name ?? collection.slice(0, 8)
}
