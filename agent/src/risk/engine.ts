/**
 * Risk engine: the single gate every action passes. Pure `checkRisk` for testing plus
 * db-backed helpers for spend and exposure accounting. Anything the gate cannot prove safe is blocked.
 */
import type { CollectionScore } from '../analysis/scoring'
import { passesScoreGate } from '../analysis/scoring'
import type { CollectionRow, CollectionStats, WalletRole } from '../analysis/market'
import { BPS, type Settings } from '../config'
import type { Db } from '../db'
import type { Action, Violation } from '../types'
import { lc } from '../util'

export interface RiskInput {
  settings: Settings
  now: number
  action: Action
  collection?: CollectionRow | null
  stats?: CollectionStats | null
  score?: CollectionScore | null
  /** Result of the profit engine for acquisition actions. */
  analysis?: { ok: boolean; netProfit: bigint; roiBps: bigint; reasons: string[] } | null
  gasCost?: bigint
  /** Unix seconds when the price evidence was last confirmed onchain. */
  priceObservedAt?: number
  fairValue?: bigint | null
  fairValueConfidence?: number
  /** Price being paid (buy) or bid (offers) per token. */
  unitPrice?: bigint
  counterparty?: string
  roles: Map<string, WalletRole>
  agent?: string | null
  exposure: { collectionCommitted: bigint; collectionTokens: number; totalCapital: bigint; openOfferCapital: bigint }
  spent: { day: bigint; week: bigint }
  /** For listings: the lowest price that still meets profit floors, and the price being set. */
  minListPrice?: bigint
  listPrice?: bigint
}

const ACQUIRE = new Set(['mint', 'buy', 'makeOffer', 'updateOffer'])
const SPENDS = new Set(['mint', 'buy'])
const TOGGLE: Record<string, keyof Settings['strategies'] | undefined> = {
  mint: 'mint', buy: 'buy', list: 'list', updateListing: 'list', makeOffer: 'offers', updateOffer: 'offers',
}

export function checkRisk(i: RiskInput): Violation[] {
  const v: Violation[] = []
  const add = (code: string, message: string) => v.push({ code, message })
  const { settings: s, action: a } = i
  const r = s.risk

  if (s.paused) add('paused', 'The global pause switch is on')
  const toggle = TOGGLE[a.kind]
  if (toggle && !s.strategies[toggle]) add('strategy-disabled', `The ${toggle} strategy is switched off`)

  if (a.collection) {
    const c = lc(a.collection)
    if (r.blocklist.map(lc).includes(c)) add('blocklisted', 'Collection is on the blocklist')
    if (r.allowlist.length > 0 && !r.allowlist.map(lc).includes(c)) add('not-allowlisted', 'Collection is not on the allowlist')
  }

  // Lowering or renewing an offer (spend <= 0) reduces exposure, so it skips the acquisition gates.
  if (ACQUIRE.has(a.kind) && !(a.kind === 'updateOffer' && a.spend <= 0n)) {
    if (r.requireVerifiedCollection && !i.collection?.verified) {
      add('unverified-contract', 'Collection was not created by the trusted factory')
    }
    if (!i.score) add('no-score', 'No collection score available')
    else if (!passesScoreGate(i.score, r.minCollectionScore, r.minScoreCoverage)) {
      add('score-below-threshold', `Score ${i.score.score} (coverage ${(i.score.coverage * 100).toFixed(0)}%) is below the configured gate`)
    }
    if (!i.analysis) add('no-analysis', 'No profitability analysis attached')
    else if (!i.analysis.ok) add('unprofitable', i.analysis.reasons.join('; ') || 'Not profitable after costs')
    if (i.gasCost !== undefined && i.gasCost > r.maxGasCostPerTx) add('gas-too-high', 'Estimated gas cost exceeds the per-transaction limit')

    const unit = i.unitPrice ?? 0n
    if (a.kind === 'mint' && unit > r.maxMintPrice) add('mint-price-too-high', 'Mint price exceeds the configured maximum')
    if ((a.kind === 'buy' || a.kind === 'makeOffer' || a.kind === 'updateOffer') && unit > r.maxPurchasePrice) {
      add('price-too-high', 'Price exceeds the configured maximum purchase price')
    }

    if (SPENDS.has(a.kind)) {
      if (i.spent.day + a.spend > r.maxDailySpend) add('daily-limit', 'Daily spending limit would be exceeded')
      if (i.spent.week + a.spend > r.maxWeeklySpend) add('weekly-limit', 'Weekly spending limit would be exceeded')
      if (i.exposure.collectionTokens + 1 > r.maxTokensPerCollection) add('token-cap', 'Per-collection token cap reached')
    }
    const committedAfter = i.exposure.collectionCommitted + (a.kind === 'updateOffer' ? 0n : a.spend)
    if (committedAfter > r.maxExposurePerCollection) add('exposure-cap', 'Per-collection exposure cap would be exceeded')
    if (i.exposure.totalCapital > 0n && (committedAfter * BPS) / i.exposure.totalCapital > BigInt(r.maxCollectionAllocationBps)) {
      add('allocation-cap', 'Collection would exceed its portfolio allocation limit')
    }
    if (a.kind === 'makeOffer' || a.kind === 'updateOffer') {
      if (i.exposure.openOfferCapital + a.spend > settings_maxOfferCapital(s)) add('offer-capital-cap', 'Capital committed to open offers would exceed the cap')
    }

    if (a.kind !== 'mint' || s.mint.requireSecondaryReference) {
      const st = i.stats
      if (!st) add('no-market-data', 'No market statistics available')
      else {
        if (st.salesCount < r.minLiquiditySales || st.uniqueBuyers < r.minDistinctBuyers) {
          add('illiquid', `Only ${st.salesCount} independent sales from ${st.uniqueBuyers} buyers in the liquidity window`)
        }
      }
    }
    if (i.priceObservedAt !== undefined && i.now - i.priceObservedAt > r.maxPriceAgeSec) {
      add('stale-price', 'Price evidence is older than the allowed age')
    }
    if (a.kind === 'buy' && i.fairValue != null && i.unitPrice !== undefined) {
      const floor = (i.fairValue * (BPS - BigInt(r.maxFairValueDiscountBps))) / BPS
      if (i.unitPrice < floor) add('suspiciously-cheap', 'Price is far below fair value: possible stale, bait or manipulated listing')
      if ((i.fairValueConfidence ?? 0) < 0.2) add('low-confidence-valuation', 'Fair value is based on too little independent evidence')
    }
    if (i.counterparty) {
      const cp = lc(i.counterparty)
      if (i.agent && cp === lc(i.agent)) add('self-trade', 'Counterparty is the agent itself')
      const role = i.roles.get(cp)
      if ((role === 'fixture' || role === 'treasury' || role === 'agent') && !r.allowFixtureCounterparties) {
        add('related-counterparty', 'Counterparty is a wallet controlled by the same operator')
      }
    }
  }

  if (a.kind === 'list' || a.kind === 'updateListing') {
    if (i.minListPrice !== undefined && i.listPrice !== undefined && i.listPrice < i.minListPrice) {
      add('below-min-profitable', 'Listing price is below the minimum profitable price')
    }
  }
  return v
}

function settings_maxOfferCapital(s: Settings): bigint {
  return s.offers.maxCapitalInOffers
}

// ------------------------------------------------------------ db-backed accounting

export function spentSince(db: Db, sinceTs: number): bigint {
  const rows = db.query('SELECT amount FROM spend WHERE ts >= ?').all(sinceTs * 1000) as Array<{ amount: string }>
  return rows.reduce((sum, r) => sum + BigInt(r.amount), 0n)
}

export function spendTotals(db: Db, now: number): { day: bigint; week: bigint } {
  return { day: spentSince(db, now - 86_400), week: spentSince(db, now - 7 * 86_400) }
}

export function recordSpend(db: Db, key: string, kind: string, amount: bigint, collection?: string): void {
  db.query('INSERT OR IGNORE INTO spend (ts, kind, amount, collection, intent_key) VALUES (?, ?, ?, ?, ?)').run(
    Date.now(), kind, amount.toString(), collection ? lc(collection) : null, key,
  )
}

export function refundSpend(db: Db, key: string): void {
  db.query('DELETE FROM spend WHERE intent_key = ?').run(key)
}

/** Capital committed to a collection: open positions at cost + live agent offers + reserved in-flight spend. */
export function collectionExposure(db: Db, collection: string, agent: string | null, now: number): {
  committed: bigint
  tokens: number
  openOfferCapital: bigint
} {
  const c = lc(collection)
  const pos = db
    .query("SELECT acquired_cost FROM positions WHERE collection = ? AND status = 'open'")
    .all(c) as Array<{ acquired_cost: string }>
  let committed = pos.reduce((s, p) => s + BigInt(p.acquired_cost), 0n)
  let openOfferCapital = 0n
  if (agent) {
    const offers = db
      .query("SELECT price, expiry FROM offers WHERE collection = ? AND bidder = ? AND status = 'active'")
      .all(c, lc(agent)) as Array<{ price: string; expiry: number }>
    for (const o of offers) if (o.expiry > now) openOfferCapital += BigInt(o.price)
  }
  committed += openOfferCapital
  // In-flight mints and buys are reserved before they become positions.
  const inflight = db
    .query(
      "SELECT kind, spend, params FROM intents WHERE collection = ? AND kind IN ('mint','buy') AND status IN ('approved','pending','submitted')",
    )
    .all(c) as Array<{ kind: string; spend: string; params: string }>
  let tokens = pos.length
  for (const f of inflight) {
    committed += BigInt(f.spend)
    let qty = 1
    if (f.kind === 'mint') {
      try {
        qty = Number((JSON.parse(f.params) as { quantity?: string }).quantity ?? 1)
      } catch {
        qty = 1
      }
    }
    tokens += qty
  }
  return { committed, tokens, openOfferCapital }
}
