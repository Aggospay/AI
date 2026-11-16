/**
 * Smart listing and price undercutting.
 *
 * Deterministic and fast: no model calls. For every token the agent holds it
 *  1. computes the minimum profitable price from everything already spent plus what it still must spend,
 *  2. finds the lowest COMPARABLE competing listing (same rarity or rarer; the agent's own listings ignored),
 *  3. targets one tick below it, never below the minimum profitable price,
 *  4. reprices only when the change is meaningful, outside the cooldown and under the hourly rate limit,
 *     with exponential backoff when a rival keeps trading blows (no endless price wars),
 *  5. raises the ask when the market improves, renews expiring listings, and sells into a bid that beats the ask.
 * When the next undercut would be unprofitable it stops lowering and waits at the minimum profitable price.
 */
import { feesFor } from '../analysis/fees'
import { agentAddress, collectionStats, tokenFairValue, walletRoles } from '../analysis/market'
import { minProfitablePrice, type FeeSchedule } from '../analysis/profit'
import { PRICE_TICK, type Settings } from '../config'
import type { Holding } from '../state/own'
import { logActivity, type Db } from '../db'
import { readCollectionApproval, readTokenOwner } from '../chain/verify'
import { listIntents } from '../exec/intents'
import { transition } from '../exec/intents'
import type { Action } from '../types'
import { floorToTick, lc, maxBig, nowSec } from '../util'
import { buildRisk, type Ctx } from './ctx'
import { comparablesFor } from './pricing'
import { shortName } from './buyer'

export type DecisionKind = 'list' | 'reprice' | 'raise' | 'renew' | 'hold' | 'accept'

export interface Decision {
  kind: DecisionKind
  price: bigint
  minPrice: bigint
  /** Lowest comparable competitor price seen, if any. */
  competitor: bigint | null
  /** True when the competitive price was below the minimum profitable price and we held at the floor. */
  atFloor: boolean
  reason: string
  offer?: { offerId: number; price: bigint; collectionWide: boolean }
}

export interface DecideInput {
  now: number
  sunkCost: bigint
  fees: FeeSchedule
  minNetProfit: bigint
  minRoiBps: bigint
  current: { price: bigint; expiry: number } | null
  lowestComparable: bigint | null
  fairValue: bigint | null
  pricing: Settings['pricing']
  lastRepriceTs: number | null
  repricesLastHour: number
  repricesLast15m: number
  bestOffer: { offerId: number; price: bigint; collectionWide: boolean } | null
  heldSec: number
  /** Gas cost of one more listing update (USDC). A raise that recovers less than this is not worth sending. */
  updateGas?: bigint
}

export function decideListing(i: DecideInput): Decision {
  const tick = PRICE_TICK
  const minPrice = minProfitablePrice(i.sunkCost, i.fees, i.minNetProfit, i.minRoiBps)
  const undercut = tick * BigInt(i.pricing.undercutTicks)

  let target: bigint
  let basis: string
  if (i.lowestComparable !== null) {
    target = i.lowestComparable > undercut ? i.lowestComparable - undercut : i.lowestComparable
    basis = `${i.pricing.undercutTicks} tick(s) below the lowest comparable listing`
  } else if (i.fairValue !== null) {
    target = i.fairValue
    basis = 'estimated fair value (no comparable competitor)'
  } else {
    target = minPrice + minPrice / 10n
    basis = 'minimum profitable price plus margin (no market reference)'
  }
  target = floorToTick(target, tick)
  let atFloor = false
  if (target < minPrice) {
    target = minPrice
    atFloor = true
    basis = 'minimum profitable price: the next undercut would not be profitable'
  }

  const base = { minPrice, competitor: i.lowestComparable, atFloor }

  // Sell into a standing bid that is at least as good as what we are asking, or when the holding has gone stale.
  if (i.bestOffer && i.bestOffer.price >= minPrice) {
    const ask = maxBig(target, i.current?.price ?? 0n)
    const stale = i.heldSec > i.pricing.expectedHoldingSec * 2
    if (i.bestOffer.price >= ask || stale) {
      return {
        ...base, kind: 'accept', price: i.bestOffer.price, offer: i.bestOffer,
        reason: i.bestOffer.price >= ask ? 'a standing offer meets or beats our ask' : 'holding period exceeded: exiting into the best offer',
      }
    }
  }

  if (!i.current) return { ...base, kind: 'list', price: target, reason: `list at ${basis}` }

  const cur = i.current
  const expiringSoon = cur.expiry !== 0 && cur.expiry - i.now < 600
  const effCooldown = Math.min(1800, i.pricing.repriceCooldownSec * 2 ** Math.max(0, i.repricesLast15m - 2))
  const inCooldown = i.lastRepriceTs !== null && i.now - i.lastRepriceTs < effCooldown
  const limited = i.repricesLastHour >= i.pricing.maxRepricesPerHour

  if (cur.price < minPrice) {
    // Never keep an unprofitable ask live, but do not chase the gas cost of repricing itself: the minimum price
    // rises by the gas of every update, so a shortfall smaller than the cost of another transaction is not worth fixing.
    const shortfall = minPrice - cur.price
    const worthIt = maxBig(tick * BigInt(i.pricing.raiseThresholdTicks), (i.updateGas ?? 0n) * 2n)
    if (shortfall < worthIt) return { ...base, kind: 'hold', price: cur.price, reason: 'ask is within the cost of another transaction of the minimum profitable price' }
    if (inCooldown) return { ...base, kind: 'hold', price: cur.price, reason: `ask is below the minimum profitable price; cooldown active (${effCooldown}s)` }
    if (limited) return { ...base, kind: 'hold', price: cur.price, reason: 'ask is below the minimum profitable price but the hourly reprice limit is reached' }
    return { ...base, kind: 'raise', price: target, reason: 'current ask fell below the minimum profitable price' }
  }

  const diff = target - cur.price
  if (diff === 0n) {
    if (expiringSoon && !limited) return { ...base, kind: 'renew', price: cur.price, reason: 'listing is about to expire' }
    return { ...base, kind: 'hold', price: cur.price, reason: atFloor ? 'holding at the minimum profitable price and waiting' : 'already at the target price' }
  }
  if (inCooldown) return { ...base, kind: 'hold', price: cur.price, reason: `cooldown active (${effCooldown}s)` }
  if (limited) return { ...base, kind: 'hold', price: cur.price, reason: 'hourly reprice limit reached' }

  if (diff < 0n) {
    if (-diff < tick * BigInt(i.pricing.minChangeTicks)) return { ...base, kind: 'hold', price: cur.price, reason: 'change smaller than the minimum step' }
    return { ...base, kind: 'reprice', price: target, reason: `lower ask: ${basis}` }
  }
  if (diff < tick * BigInt(i.pricing.raiseThresholdTicks)) return { ...base, kind: 'hold', price: cur.price, reason: 'market improvement too small to justify a raise' }
  return { ...base, kind: 'raise', price: target, reason: `market improved: ${basis}` }
}

// ---------------------------------------------------------------- runner

/** Gas already spent on selling this token (listing, repricing, accepting). Acquisition gas is in acquiredCost. */
function sellGasSpent(db: Db, collection: string, tokenId: string, sinceMs: number, paper: boolean): bigint {
  const rows = db
    .query(
      `SELECT l.amount AS amount FROM ledger l JOIN intents i ON i.key = l.intent_key
       WHERE l.kind = 'gas' AND l.collection = ? AND l.token_id = ? AND l.ts >= ? AND l.paper = ?
         AND i.kind IN ('list','updateListing','cancelListing','acceptOffer')`,
    )
    .all(lc(collection), tokenId, sinceMs, paper ? 1 : 0) as Array<{ amount: string }>
  return rows.reduce((s, r) => s - BigInt(r.amount), 0n)
}

function repriceStats(db: Db, collection: string, tokenId: string, now: number) {
  const rows = db
    .query('SELECT ts FROM reprices WHERE collection = ? AND token_id = ? AND ts >= ? ORDER BY ts DESC')
    .all(lc(collection), tokenId, now - 3600) as Array<{ ts: number }>
  return {
    last: rows.length ? rows[0].ts : null,
    hour: rows.length,
    quarter: rows.filter((r) => r.ts >= now - 900).length,
  }
}

/** Supersede stale proposals and report whether an intent for this token is already in flight. */
function inFlight(db: Db, kinds: string[], collection: string, tokenId: string): boolean {
  const open = listIntents(db, ['proposed', 'approved', 'pending', 'submitted'], 200).filter(
    (i) => kinds.includes(i.kind) && i.collection === lc(collection) && i.tokenId === tokenId,
  )
  const active = open.filter((i) => i.status !== 'proposed')
  return active.length > 0
}

function supersedeProposals(db: Db, kinds: string[], collection: string, tokenId: string): void {
  for (const i of listIntents(db, ['proposed'], 200)) {
    if (kinds.includes(i.kind) && i.collection === lc(collection) && i.tokenId === tokenId) {
      transition(db, i.key, 'proposed', 'rejected', { error: 'superseded by a newer decision' })
    }
  }
}

export interface HoldingEvaluation {
  d: Decision
  stats: ReturnType<typeof collectionStats>
  current: ReturnType<Ctx['own']['listingOf']>
  tokenFair: bigint | null
  sunk: bigint
}

/** Computes the pricing decision for one holding. Shared by the repricer and the portfolio view. */
export function evaluateHolding(
  ctx: Ctx, h: Holding, now: number, agent: string, opts: { ignoreCooldown: boolean },
): HoldingEvaluation {
  const s = ctx.getSettings()
  const roles = walletRoles(ctx.db)
  const paper = ctx.own.paper()
  const stats = collectionStats(ctx.db, h.collection, s, now)
  const cmp = comparablesFor(ctx, h.collection, h.tokenId, now, agent)
  const tfv = tokenFairValue(stats, cmp.rarity.get(h.tokenId))
  const fees = feesFor(ctx.db, h.collection)
  const current = ctx.own.listingOf(h.collection, h.tokenId)
  // Selling gas is budgeted once (one listing plus two reprices). Actual spend only raises the floor when it
  // exceeds that budget, so repricing never chases its own gas cost upward.
  const plannedSellGas = ctx.gas.costUsdc('list') + ctx.gas.costUsdc('updateListing', 2)
  const spentSellGas = sellGasSpent(ctx.db, h.collection, h.tokenId, h.acquiredTs, paper)
  const sellGas = spentSellGas > plannedSellGas ? spentSellGas : plannedSellGas
  const sunk = h.acquiredCost + sellGas + s.risk.otherCostsPerTrade

  const offers = ctx.db
    .query("SELECT * FROM offers WHERE status = 'active' AND collection = ? AND expiry > ? AND bidder != ?")
    .all(lc(h.collection), now, agent) as Array<{ offer_id: number; token_id: string; collection_wide: number; price: string; bidder: string }>
  let bestOffer: Decision['offer'] | null = null
  for (const o of offers) {
    if (o.collection_wide !== 1 && o.token_id !== h.tokenId) continue
    if (!s.risk.allowFixtureCounterparties && roles.get(lc(o.bidder)) === 'fixture') continue
    const price = BigInt(o.price)
    if (!bestOffer || price > bestOffer.price) bestOffer = { offerId: o.offer_id, price, collectionWide: o.collection_wide === 1 }
  }

  const rs = opts.ignoreCooldown ? { last: null, hour: 0, quarter: 0 } : repriceStats(ctx.db, h.collection, h.tokenId, now)
  const d = decideListing({
    now, sunkCost: sunk, fees, minNetProfit: s.risk.minNetProfit, minRoiBps: BigInt(s.risk.minRoiBps),
    current: current ? { price: current.price, expiry: current.expiry } : null,
    lowestComparable: cmp.lowest?.price ?? null, fairValue: tfv.value, pricing: s.pricing,
    lastRepriceTs: rs.last, repricesLastHour: rs.hour, repricesLast15m: rs.quarter, bestOffer,
    heldSec: now - Math.floor(h.acquiredTs / 1000), updateGas: ctx.gas.costUsdc('updateListing'),
  })
  return { d, stats, current, tokenFair: tfv.value, sunk }
}

export async function runRepricer(ctx: Ctx): Promise<void> {
  const s = ctx.getSettings()
  if (s.paused || !s.strategies.list || !ctx.env.market) return
  const now = nowSec()
  const agent = agentAddress(ctx.db)
  if (!agent) return
  const paper = ctx.own.paper()
  const approved = new Set<string>()

  for (const h of ctx.own.holdings()) {
    const collectionRow = ctx.db.query('SELECT address FROM collections WHERE address = ? AND verified = 1').get(lc(h.collection))
    if (!collectionRow) continue

    // Approval of the market for this collection (live only: paper has nothing to sign).
    if (!paper && !approved.has(h.collection)) {
      const ok = await readCollectionApproval(ctx.client, h.collection as `0x${string}`, agent as `0x${string}`, ctx.env.market)
      if (!ok) {
        const a: Action = {
          key: `approveCollection:${h.collection}`, kind: 'approveCollection', strategy: 'list', collection: h.collection,
          params: { collection: h.collection }, spend: 0n, gasEstimate: ctx.gas.costUsdc('approveCollection'),
          summary: `Approve the market to transfer ${shortName(ctx, h.collection)} tokens when sold`,
        }
        await ctx.exec.submit(a, await buildRisk(ctx, a))
        continue
      }
      approved.add(h.collection)
    }

    if (inFlight(ctx.db, ['list', 'updateListing', 'acceptOffer'], h.collection, h.tokenId)) continue
    // The index can lag a sale by a moment (for example a just-accepted offer): confirm we still own the token
    // onchain before sending anything that would fail.
    if (!paper && (await readTokenOwner(ctx.client, h.collection as `0x${string}`, h.tokenId)) !== agent) continue

    const ev = evaluateHolding(ctx, h, now, agent, { ignoreCooldown: false })
    const { d, stats, current } = ev
    if (d.kind === 'hold') continue

    const name = shortName(ctx, h.collection)
    const expiry = (now + s.pricing.listingDurationSec).toString()
    let action: Action
    if (d.kind === 'accept' && d.offer) {
      action = {
        key: `accept:${d.offer.offerId}:${h.tokenId}`, kind: 'acceptOffer', strategy: 'list', collection: h.collection, tokenId: h.tokenId,
        params: { offerId: String(d.offer.offerId), tokenId: h.tokenId, minPrice: d.offer.price.toString(), collectionWide: d.offer.collectionWide },
        spend: 0n, gasEstimate: ctx.gas.costUsdc('acceptOffer'),
        summary: `Sell ${name} #${h.tokenId} into an offer of ${(Number(d.offer.price) / 1e6).toFixed(3)} USDC (${d.reason})`,
        analysis: { minProfitablePrice: d.minPrice, reason: d.reason },
      }
    } else if (d.kind === 'list') {
      action = {
        key: `list:${h.collection}:${h.tokenId}:${d.price}`, kind: 'list', strategy: 'list', collection: h.collection, tokenId: h.tokenId,
        params: { collection: h.collection, tokenId: h.tokenId, price: d.price.toString(), expiry },
        spend: 0n, gasEstimate: ctx.gas.costUsdc('list'),
        summary: `List ${name} #${h.tokenId} at ${(Number(d.price) / 1e6).toFixed(3)} USDC (${d.reason})`,
        analysis: { minProfitablePrice: d.minPrice, competitor: d.competitor, atFloor: d.atFloor, reason: d.reason },
      }
    } else {
      action = {
        key: `updateListing:${h.collection}:${h.tokenId}:${current?.price}>${d.price}:${Math.floor(now / 60)}`, kind: 'updateListing',
        strategy: 'list', collection: h.collection, tokenId: h.tokenId,
        params: { collection: h.collection, tokenId: h.tokenId, price: d.price.toString(), expiry },
        spend: 0n, gasEstimate: ctx.gas.costUsdc('updateListing'),
        summary: `${d.kind === 'raise' ? 'Raise' : d.kind === 'renew' ? 'Renew' : 'Reprice'} ${name} #${h.tokenId} to ${(Number(d.price) / 1e6).toFixed(3)} USDC (${d.reason})`,
        analysis: { minProfitablePrice: d.minPrice, competitor: d.competitor, atFloor: d.atFloor, reason: d.reason },
      }
    }

    supersedeProposals(ctx.db, ['list', 'updateListing', 'acceptOffer'], h.collection, h.tokenId)
    const risk = await buildRisk(ctx, action, { stats, minListPrice: d.minPrice, listPrice: d.price })
    const res = await ctx.exec.submit(action, risk)
    if ((res.status === 'running' || res.status === 'proposed') && (d.kind === 'reprice' || d.kind === 'raise' || d.kind === 'renew')) {
      ctx.db
        .query('INSERT INTO reprices (collection, token_id, ts, from_price, to_price, reason) VALUES (?, ?, ?, ?, ?, ?)')
        .run(lc(h.collection), h.tokenId, now, String(current?.price ?? 0n), d.price.toString(), d.reason)
    }
    if (res.status === 'blocked') {
      logActivity(ctx.db, { strategy: 'list', level: 'warn', message: `Listing action blocked for #${h.tokenId}: ${res.violations.map((v) => v.code).join(', ')}` })
    }
  }
}
