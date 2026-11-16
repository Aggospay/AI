/**
 * Market data access and valuation. Reads SQLite projections; no chain calls.
 * Anti-manipulation: sales between related wallets, self trades, round trips and statistical
 * outliers never feed fair value. Simulated fixture wallets are never "independent demand".
 */
import type { Db } from '../db'
import type { Settings } from '../config'
import { absDiff, lc, median } from '../util'

export type WalletRole = 'agent' | 'fixture' | 'treasury' | 'external'

export interface CollectionRow {
  address: string
  creator: string
  name: string
  symbol: string
  mintPrice: bigint
  maxSupply: number
  maxPerWallet: number
  mintStart: number
  mintEnd: number
  royaltyBps: number
  createdTs: number
  totalMinted: number
  revealed: boolean
  verified: boolean
}

export interface ListingRow {
  collection: string
  tokenId: string
  seller: string
  price: bigint
  expiry: number
  listedTs: number
  updatedTs: number
}

export interface OfferRow {
  offerId: number
  collection: string
  tokenId: string
  collectionWide: boolean
  bidder: string
  price: bigint
  expiry: number
  createdTs: number
  updatedTs: number
}

export interface SaleRow {
  id: number
  collection: string
  tokenId: string
  seller: string
  buyer: string
  price: bigint
  fee: bigint
  royalty: bigint
  kind: number
  ts: number
}

interface RawRow { [k: string]: unknown }
const big = (v: unknown): bigint => BigInt(String(v))

export function toCollection(r: RawRow): CollectionRow {
  return {
    address: String(r.address), creator: String(r.creator), name: String(r.name), symbol: String(r.symbol),
    mintPrice: big(r.mint_price), maxSupply: Number(r.max_supply), maxPerWallet: Number(r.max_per_wallet),
    mintStart: Number(r.mint_start), mintEnd: Number(r.mint_end), royaltyBps: Number(r.royalty_bps),
    createdTs: Number(r.created_ts), totalMinted: Number(r.total_minted), revealed: Number(r.revealed) === 1,
    verified: Number(r.verified) === 1,
  }
}

export function listCollections(db: Db): CollectionRow[] {
  return (db.query('SELECT * FROM collections ORDER BY created_block DESC').all() as RawRow[]).map(toCollection)
}

export function getCollection(db: Db, address: string): CollectionRow | null {
  const r = db.query('SELECT * FROM collections WHERE address = ?').get(lc(address)) as RawRow | null
  return r ? toCollection(r) : null
}

const toListing = (r: RawRow): ListingRow => ({
  collection: String(r.collection), tokenId: String(r.token_id), seller: String(r.seller), price: big(r.price),
  expiry: Number(r.expiry), listedTs: Number(r.listed_ts), updatedTs: Number(r.updated_ts),
})

export function activeListings(db: Db, now: number, collection?: string): ListingRow[] {
  const rows = (
    collection
      ? db.query("SELECT * FROM listings WHERE status = 'active' AND collection = ?").all(lc(collection))
      : db.query("SELECT * FROM listings WHERE status = 'active'").all()
  ) as RawRow[]
  return rows.map(toListing).filter((l) => l.expiry === 0 || l.expiry > now)
}

export function getListing(db: Db, collection: string, tokenId: string): ListingRow | null {
  const r = db
    .query("SELECT * FROM listings WHERE collection = ? AND token_id = ? AND status = 'active'")
    .get(lc(collection), tokenId) as RawRow | null
  return r ? toListing(r) : null
}

const toOffer = (r: RawRow): OfferRow => ({
  offerId: Number(r.offer_id), collection: String(r.collection), tokenId: String(r.token_id),
  collectionWide: Number(r.collection_wide) === 1, bidder: String(r.bidder), price: big(r.price),
  expiry: Number(r.expiry), createdTs: Number(r.created_ts), updatedTs: Number(r.updated_ts),
})

export function activeOffers(db: Db, now: number, collection?: string): OfferRow[] {
  const rows = (
    collection
      ? db.query("SELECT * FROM offers WHERE status = 'active' AND collection = ?").all(lc(collection))
      : db.query("SELECT * FROM offers WHERE status = 'active'").all()
  ) as RawRow[]
  return rows.map(toOffer).filter((o) => o.expiry > now)
}

export function walletRoles(db: Db): Map<string, WalletRole> {
  const out = new Map<string, WalletRole>()
  for (const r of db.query('SELECT address, role FROM wallets').all() as Array<{ address: string; role: WalletRole }>) {
    out.set(lc(r.address), r.role)
  }
  return out
}

export function agentAddress(db: Db): string | null {
  const r = db.query("SELECT address FROM wallets WHERE role = 'agent' LIMIT 1").get() as { address: string } | null
  return r ? lc(r.address) : null
}

// ---------------------------------------------------------------- sales hygiene

export type ExclusionReason = 'self-trade' | 'related-wallets' | 'fixture' | 'round-trip' | 'outlier'

export interface CleanSales {
  clean: SaleRow[]
  excluded: Array<{ sale: SaleRow; reason: ExclusionReason }>
}

const toSale = (r: RawRow): SaleRow => ({
  id: Number(r.id), collection: String(r.collection), tokenId: String(r.token_id), seller: String(r.seller),
  buyer: String(r.buyer), price: big(r.price), fee: big(r.fee), royalty: big(r.royalty), kind: Number(r.kind),
  ts: Number(r.ts),
})

export function recentSales(db: Db, collection: string, sinceTs: number): SaleRow[] {
  return (
    db
      .query('SELECT * FROM sales WHERE collection = ? AND ts >= ? ORDER BY ts ASC')
      .all(lc(collection), sinceTs) as RawRow[]
  ).map(toSale)
}

/** Filters a chronological sale list down to trades usable as independent price evidence. */
export function cleanSales(
  sales: SaleRow[],
  roles: Map<string, WalletRole>,
  madMultiple: number,
  /** Test harness only: treat simulated rival wallets as independent participants. Off by default. */
  includeFixtures = false,
): CleanSales {
  const excluded: CleanSales['excluded'] = []
  const stage1: SaleRow[] = []
  const registry = (a: string) => {
    const r = roles.get(lc(a))
    return r !== undefined && r !== 'external'
  }
  for (const s of sales) {
    if (lc(s.seller) === lc(s.buyer)) excluded.push({ sale: s, reason: 'self-trade' })
    else if (!includeFixtures && (roles.get(lc(s.seller)) === 'fixture' || roles.get(lc(s.buyer)) === 'fixture'))
      excluded.push({ sale: s, reason: 'fixture' })
    else if (registry(s.seller) && registry(s.buyer) && !(includeFixtures && (roles.get(lc(s.seller)) === 'fixture' || roles.get(lc(s.buyer)) === 'fixture')))
      excluded.push({ sale: s, reason: 'related-wallets' })
    else stage1.push(s)
  }
  // Round trips: A -> B then B -> A for the same token inside 24h taints both legs.
  const taint = new Set<number>()
  for (let i = 0; i < stage1.length; i++) {
    for (let j = i + 1; j < stage1.length; j++) {
      const a = stage1[i]
      const b = stage1[j]
      if (b.ts - a.ts > 86_400) break
      if (a.tokenId === b.tokenId && lc(a.seller) === lc(b.buyer) && lc(a.buyer) === lc(b.seller)) {
        taint.add(a.id)
        taint.add(b.id)
      }
    }
  }
  const stage2: SaleRow[] = []
  for (const s of stage1) {
    if (taint.has(s.id)) excluded.push({ sale: s, reason: 'round-trip' })
    else stage2.push(s)
  }
  // Outliers by median absolute deviation (needs enough samples to be meaningful).
  if (stage2.length < 5) return { clean: stage2, excluded }
  const prices = stage2.map((s) => s.price)
  const med = median(prices) as bigint
  const mad = median(prices.map((p) => absDiff(p, med))) as bigint
  const floorMad = mad > 1000n ? mad : 1000n
  const limit = floorMad * BigInt(Math.round(madMultiple * 100)) / 100n
  const clean: SaleRow[] = []
  for (const s of stage2) {
    if (absDiff(s.price, med) > limit) excluded.push({ sale: s, reason: 'outlier' })
    else clean.push(s)
  }
  return { clean, excluded }
}

// ---------------------------------------------------------------- rarity

export interface RarityInfo {
  score: number
  percentile: number // 0 = rarest, 1 = most common
  tier: number // 0 rarest ... 3 common, 99 unknown
}

const unpack = (packed: number): number[] => [0, 1, 2, 3].map((i) => (packed >>> (i * 8)) & 0xff)

export function rarityTable(db: Db, collection: string): Map<string, RarityInfo> {
  const rows = db
    .query('SELECT token_id, traits FROM tokens WHERE collection = ? AND traits IS NOT NULL')
    .all(lc(collection)) as Array<{ token_id: string; traits: number }>
  const out = new Map<string, RarityInfo>()
  if (rows.length === 0) return out
  const counts: Array<Map<number, number>> = [new Map<number, number>(), new Map<number, number>(), new Map<number, number>(), new Map<number, number>()]
  for (const r of rows) unpack(r.traits).forEach((v, i) => counts[i].set(v, (counts[i].get(v) ?? 0) + 1))
  const scored = rows.map((r) => {
    const score = unpack(r.traits).reduce((sum, v, i) => sum - Math.log2((counts[i].get(v) ?? 1) / rows.length), 0)
    return { id: r.token_id, score }
  })
  // Percentile = share of tokens at least as rare as this one. Ties share the same (conservative) percentile,
  // so a trait combination held by many tokens can never be mistaken for a rare one.
  const sortedScores = scored.map((x) => x.score).sort((a, b) => b - a)
  for (const s of scored) {
    const atLeastAsRare = sortedScores.filter((v) => v >= s.score - 1e-9).length
    const percentile = atLeastAsRare / rows.length
    const tier = percentile <= 0.05 ? 0 : percentile <= 0.2 ? 1 : percentile <= 0.5 ? 2 : 3
    out.set(s.id, { score: s.score, percentile, tier })
  }
  return out
}

export const UNKNOWN_TIER = 99

/** Conservative rarity premium schedule, applied only to revealed tokens. */
export function rarityPremiumBps(tier: number): number {
  if (tier === 0) return 4000
  if (tier === 1) return 1500
  if (tier === 2) return 0
  if (tier === 3) return -500
  return 0
}

// ---------------------------------------------------------------- collection stats

export interface CollectionStats {
  collection: string
  floor: bigint | null
  floorTokenId: string | null
  activeListings: number
  salesCount: number
  excludedSales: number
  uniqueBuyers: number
  uniqueSellers: number
  volume: bigint
  medianPrice: bigint | null
  lastSalePrice: bigint | null
  lastSaleTs: number | null
  fairValue: bigint | null
  confidence: number
  bestCollectionOffer: bigint | null
  holders: number
  topHolderShareBps: number
  dataAgeSec: number | null
}

export function collectionStats(db: Db, collection: string, settings: Settings, now: number): CollectionStats {
  const c = lc(collection)
  const roles = walletRoles(db)
  const window = settings.risk.minLiquidityWindowSec
  const week = Math.max(window, 7 * 86_400)
  const all = recentSales(db, c, now - week)
  const { clean, excluded } = cleanSales(all, roles, settings.risk.outlierMadMultiple, settings.risk.allowFixtureCounterparties)
  const inWindow = clean.filter((s) => s.ts >= now - window)
  const listings = activeListings(db, now, c)
  let floor: ListingRow | null = null
  for (const l of listings) if (!floor || l.price < floor.price) floor = l
  const offers = activeOffers(db, now, c).filter((o) => o.collectionWide)
  const agent = agentAddress(db)
  const bestOffer = offers.filter((o) => o.bidder !== agent).reduce<bigint | null>(
    (best, o) => (best === null || o.price > best ? o.price : best), null,
  )
  const prices = clean.slice(-10).map((s) => s.price)
  const med = median(prices) ?? null
  const last = clean.length ? clean[clean.length - 1] : null

  // Fair value: median of the last clean sales; falls back to the floor with low confidence.
  let fair: bigint | null = med
  let confidence = 0
  if (med !== null) {
    const n = Math.min(prices.length, 10)
    const ageSec = last ? now - last.ts : week
    const dispersion = prices.length > 1
      ? Number(median(prices.map((p) => absDiff(p, med)))! * 1000n / (med > 0n ? med : 1n)) / 1000
      : 0.5
    confidence = Math.max(0, Math.min(1, (n / 10) * 0.6 + (1 - Math.min(1, ageSec / week)) * 0.25 + (1 - Math.min(1, dispersion)) * 0.15))
  } else if (floor) {
    fair = floor.price
    confidence = 0.15
  }

  const holdersRows = db
    .query('SELECT owner, COUNT(*) AS n FROM tokens WHERE collection = ? GROUP BY owner ORDER BY n DESC')
    .all(c) as Array<{ owner: string; n: number }>
  const totalTokens = holdersRows.reduce((s, r) => s + r.n, 0)
  const topShare = totalTokens > 0 ? Math.round((holdersRows[0].n * 10_000) / totalTokens) : 0

  const lastObs = last?.ts ?? floor?.updatedTs ?? null
  return {
    collection: c,
    floor: floor?.price ?? null,
    floorTokenId: floor?.tokenId ?? null,
    activeListings: listings.length,
    salesCount: inWindow.length,
    excludedSales: excluded.length,
    uniqueBuyers: new Set(inWindow.map((s) => lc(s.buyer))).size,
    uniqueSellers: new Set(inWindow.map((s) => lc(s.seller))).size,
    volume: inWindow.reduce((s, x) => s + x.price, 0n),
    medianPrice: med,
    lastSalePrice: last?.price ?? null,
    lastSaleTs: last?.ts ?? null,
    fairValue: fair,
    confidence,
    bestCollectionOffer: bestOffer,
    holders: holdersRows.length,
    topHolderShareBps: topShare,
    dataAgeSec: lastObs === null ? null : Math.max(0, now - lastObs),
  }
}

/** Token-level fair value: collection fair value adjusted by rarity tier when traits are known. */
export function tokenFairValue(
  stats: CollectionStats,
  rarity: RarityInfo | undefined,
): { value: bigint | null; tier: number; confidence: number } {
  if (stats.fairValue === null) return { value: null, tier: UNKNOWN_TIER, confidence: 0 }
  if (!rarity) return { value: stats.fairValue, tier: UNKNOWN_TIER, confidence: stats.confidence }
  const bps = BigInt(10_000 + rarityPremiumBps(rarity.tier))
  return {
    value: (stats.fairValue * bps) / 10_000n,
    tier: rarity.tier,
    // Premium is a schedule, not evidence: cap confidence.
    confidence: Math.min(stats.confidence, 0.7),
  }
}

/** Competitor listings comparable to a token of `tier` (same tier or rarer; unknown matches unknown). */
export function comparableListings(
  listings: ListingRow[],
  rarity: Map<string, RarityInfo>,
  ourTier: number,
  exclude: { seller?: string; tokenId?: string },
): ListingRow[] {
  return listings.filter((l) => {
    if (exclude.seller && lc(l.seller) === lc(exclude.seller)) return false
    if (exclude.tokenId !== undefined && l.tokenId === exclude.tokenId) return false
    const t = rarity.get(l.tokenId)?.tier ?? UNKNOWN_TIER
    if (ourTier === UNKNOWN_TIER) return true
    if (t === UNKNOWN_TIER) return true
    return t <= ourTier
  })
}
