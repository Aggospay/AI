/**
 * Portfolio management: reconciles positions with chain state, computes realized and unrealized
 * performance, gas and fee totals, collection exposure, and a hold / reprice / sell / delist
 * recommendation for every holding.
 */
import { agentAddress, collectionStats, getCollection, listCollections, tokenFairValue } from '../analysis/market'
import { feesFor } from '../analysis/fees'
import { settle } from '../analysis/profit'
import { scoreCollection } from '../analysis/scoring'
import { logActivity } from '../db'
import { lc, nowMs, nowSec } from '../util'
import type { Ctx } from './ctx'
import { comparablesFor } from './pricing'
import { evaluateHolding } from './repricer'

type Raw = Record<string, string | number | null>

/** Live mode: opens positions for tokens the agent now owns, closes those it no longer owns. */
export function syncPositions(ctx: Ctx): { opened: number; closed: number } {
  if (ctx.own.paper()) return { opened: 0, closed: 0 }
  const agent = agentAddress(ctx.db)
  if (!agent) return { opened: 0, closed: 0 }
  const db = ctx.db
  let opened = 0
  let closed = 0

  const owned = db.query('SELECT collection, token_id, minter, minted_ts FROM tokens WHERE owner = ?').all(agent) as Array<{
    collection: string; token_id: string; minter: string | null; minted_ts: number | null
  }>
  for (const t of owned) {
    const exists = db
      .query("SELECT 1 FROM positions WHERE collection = ? AND token_id = ? AND status = 'open' AND paper = 0")
      .get(t.collection, t.token_id)
    if (exists) continue
    const sale = db
      .query('SELECT price, ts, kind FROM sales WHERE collection = ? AND token_id = ? AND buyer = ? ORDER BY ts DESC LIMIT 1')
      .get(t.collection, t.token_id, agent) as { price: string; ts: number; kind: number } | null
    const coll = getCollection(db, t.collection)
    let price: bigint
    let source: string
    let ts: number
    if (sale) {
      price = BigInt(sale.price)
      source = sale.kind === 0 ? 'buy' : 'offer'
      ts = sale.ts * 1000
    } else if (t.minter === agent && coll) {
      price = coll.mintPrice
      source = 'mint'
      ts = (t.minted_ts ?? nowSec()) * 1000
    } else {
      // Received by plain transfer: no known cost basis. Treat as zero cost so P&L is not overstated by guesswork.
      price = 0n
      source = 'transfer'
      ts = nowMs()
    }
    const kind = source === 'mint' ? 'mint' : 'buy'
    const intent = db
      .query("SELECT key, est_cost FROM intents WHERE kind = ? AND collection = ? AND status = 'confirmed' ORDER BY updated_ts DESC LIMIT 1")
      .get(kind, t.collection) as { key: string; est_cost: string } | null
    let gas = 0n
    if (intent && source !== 'transfer') {
      const g = db.query("SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS s FROM ledger WHERE kind = 'gas' AND intent_key = ? AND paper = 0").get(intent.key) as { s: number }
      gas = BigInt(-g.s)
      if (gas === 0n) gas = BigInt(intent.est_cost)
    }
    db.query(
      `INSERT INTO positions (collection, token_id, source, acquired_price, acquired_cost, acquired_ts, status, paper, intent_key)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?)`,
    ).run(t.collection, t.token_id, source, price.toString(), (price + gas).toString(), ts, intent?.key ?? null)
    db.query('INSERT INTO ledger (ts, kind, collection, token_id, amount, note, paper) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
      nowMs(), source === 'mint' ? 'mint' : 'buy', t.collection, t.token_id, (-price).toString(), `acquired via ${source}`,
    )
    opened++
    logActivity(db, { strategy: 'portfolio', message: `Position opened: #${t.token_id} (${source}) at ${(Number(price) / 1e6).toFixed(3)} USDC`, data: { collection: t.collection } })
  }

  const open = db.query("SELECT * FROM positions WHERE status = 'open' AND paper = 0").all() as Raw[]
  for (const p of open) {
    const tok = db.query('SELECT owner FROM tokens WHERE collection = ? AND token_id = ?').get(String(p.collection), String(p.token_id)) as {
      owner: string
    } | null
    if (!tok || tok.owner === agent) continue
    const sale = db
      .query('SELECT price, fee, royalty, ts FROM sales WHERE collection = ? AND token_id = ? AND seller = ? AND ts >= ? ORDER BY ts DESC LIMIT 1')
      .get(String(p.collection), String(p.token_id), agent, Math.floor(Number(p.acquired_ts) / 1000) - 5) as {
      price: string; fee: string; royalty: string; ts: number
    } | null
    const cost = BigInt(String(p.acquired_cost))
    const gross = sale ? BigInt(sale.price) : 0n
    const net = sale ? gross - BigInt(sale.fee) - BigInt(sale.royalty) : 0n
    const realized = net - cost
    db.query("UPDATE positions SET status = ?, sold_price = ?, sold_net = ?, sold_ts = ?, realized = ? WHERE id = ?").run(
      sale ? 'sold' : 'closed', gross.toString(), net.toString(), (sale?.ts ?? nowSec()) * 1000, realized.toString(), Number(p.id),
    )
    if (sale) {
      db.query('INSERT INTO ledger (ts, kind, collection, token_id, amount, note, paper) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
        nowMs(), 'sale', String(p.collection), String(p.token_id), net.toString(), `sold at ${gross}`,
      )
      const coll = getCollection(db, String(p.collection))
      if (coll) {
        const stats = collectionStats(db, coll.address, ctx.getSettings(), nowSec())
        const score = scoreCollection(coll, stats, 0)
        db.query('INSERT INTO score_outcomes (collection, score, realized, ts) VALUES (?, ?, ?, ?)').run(
          coll.address, score.score, realized.toString(), nowMs(),
        )
      }
    }
    closed++
    logActivity(db, { strategy: 'portfolio', message: `Position ${sale ? 'sold' : 'closed'}: #${String(p.token_id)} (realized ${(Number(realized) / 1e6).toFixed(3)} USDC)`, data: { collection: String(p.collection) } })
  }
  return { opened, closed }
}

export type Recommendation = 'hold' | 'list' | 'reprice' | 'sell' | 'delist'

export async function portfolioSummary(ctx: Ctx) {
  const s = ctx.getSettings()
  const now = nowSec()
  const agent = agentAddress(ctx.db)
  const paper = ctx.own.paper()
  const capital = await ctx.own.capital()

  const holdings = ctx.own.holdings().map((h) => {
    const coll = getCollection(ctx.db, h.collection)
    const stats = collectionStats(ctx.db, h.collection, s, now)
    let mark: bigint | null = null
    let markNet: bigint | null = null
    let rec: Recommendation = 'hold'
    let reason = 'no action needed'
    let listing = ctx.own.listingOf(h.collection, h.tokenId)
    let minPrice: bigint | null = null
    let competitor: bigint | null = null
    let tier: number | null = null
    try {
      const cmp = comparablesFor(ctx, h.collection, h.tokenId, now, agent)
      const tfv = tokenFairValue(stats, cmp.rarity.get(h.tokenId))
      tier = cmp.rarity.get(h.tokenId)?.tier ?? null
      mark = tfv.value
      if (mark !== null) markNet = settle(mark, feesFor(ctx.db, h.collection)).proceeds
      if (agent) {
        const ev = evaluateHolding(ctx, h, now, agent, { ignoreCooldown: true })
        minPrice = ev.d.minPrice
        competitor = ev.d.competitor
        listing = ev.current
        if (ev.d.kind === 'accept') { rec = 'sell'; reason = ev.d.reason }
        else if (ev.d.kind === 'list') { rec = 'list'; reason = ev.d.reason }
        else if (ev.d.kind === 'reprice' || ev.d.kind === 'raise' || ev.d.kind === 'renew') { rec = 'reprice'; reason = ev.d.reason }
        else { rec = 'hold'; reason = ev.d.reason }
      }
      const r = s.risk
      if (coll && (r.blocklist.map(lc).includes(coll.address) || !coll.verified)) {
        if (listing) { rec = 'delist'; reason = 'collection is blocklisted or unverified' }
      }
    } catch {
      reason = 'valuation unavailable'
    }
    const unrealized = markNet === null ? null : markNet - h.acquiredCost
    return {
      collection: h.collection, collectionName: coll?.name ?? h.collection.slice(0, 8), tokenId: h.tokenId, source: h.source,
      acquiredPrice: h.acquiredPrice, acquiredCost: h.acquiredCost, acquiredTs: h.acquiredTs,
      listingPrice: listing?.price ?? null, listingExpiry: listing?.expiry ?? null,
      markValue: mark, markNet, unrealized, minProfitablePrice: minPrice, lowestCompetitor: competitor, tier,
      recommendation: rec, reason,
    }
  })

  const closed = ctx.db.query("SELECT * FROM positions WHERE status IN ('sold','closed') AND paper = ?").all(paper ? 1 : 0) as Raw[]
  const sum = (rows: Raw[], f: (r: Raw) => bigint) => rows.reduce((t, r) => t + f(r), 0n)
  const realized = sum(closed, (r) => BigInt(String(r.realized ?? '0')))
  const feesPaid = sum(closed, (r) => (r.sold_price && r.sold_net ? BigInt(String(r.sold_price)) - BigInt(String(r.sold_net)) : 0n))
  const since = (secs: number) => closed.filter((r) => Number(r.sold_ts ?? 0) >= (now - secs) * 1000)
  const realizedDay = sum(since(86_400), (r) => BigInt(String(r.realized ?? '0')))
  const realizedWeek = sum(since(7 * 86_400), (r) => BigInt(String(r.realized ?? '0')))
  const gasRow = ctx.db.query("SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS s FROM ledger WHERE kind = 'gas' AND paper = ?").get(paper ? 1 : 0) as { s: number }
  const unrealized = holdings.reduce((t, h) => t + (h.unrealized ?? 0n), 0n)

  const byCollection = new Map<string, { name: string; cost: bigint; count: number; offers: bigint }>()
  for (const h of holdings) {
    const e = byCollection.get(h.collection) ?? { name: h.collectionName, cost: 0n, count: 0, offers: 0n }
    e.cost += h.acquiredCost
    e.count += 1
    byCollection.set(h.collection, e)
  }
  for (const o of ctx.own.offers()) {
    const e = byCollection.get(o.collection) ?? { name: getCollection(ctx.db, o.collection)?.name ?? o.collection.slice(0, 8), cost: 0n, count: 0, offers: 0n }
    e.offers += o.price
    byCollection.set(o.collection, e)
  }
  const invested = holdings.reduce((t, h) => t + h.acquiredCost, 0n)
  const totalCapital = capital.available + capital.committedToOffers + invested
  const exposure = [...byCollection.entries()].map(([address, e]) => ({
    collection: address, name: e.name, tokens: e.count, positionCost: e.cost, offerCapital: e.offers,
    shareBps: totalCapital > 0n ? Number(((e.cost + e.offers) * 10_000n) / totalCapital) : 0,
  }))

  return {
    mode: s.mode,
    capital,
    totalCapital,
    totalValue: capital.available + capital.committedToOffers + holdings.reduce((t, h) => t + (h.markNet ?? h.acquiredCost), 0n),
    realized, unrealized, realizedDay, realizedWeek,
    gasTotal: BigInt(-gasRow.s), feesPaid,
    holdings, exposure,
    counts: {
      open: holdings.length, listings: ctx.own.listings().length, offers: ctx.own.offers().length,
      collections: listCollections(ctx.db).length,
    },
  }
}
