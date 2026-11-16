/**
 * Paper executor. Applies actions to simulated state only: nothing is signed or sent.
 * Fill model (documented heuristic, not a promise of live performance):
 *  - a paper listing sells when a real, independent sale in the same collection prints at or above
 *    the listing price after the listing was created;
 *  - a paper offer fills when a real active listing in the collection (that token for token offers)
 *    is priced at or below the bid;
 *  - buys fill against real indexed listings at their listed price.
 */
import { feesFor } from '../analysis/fees'
import { cleanSales, getCollection, getListing, activeListings, recentSales, walletRoles } from '../analysis/market'
import { settle } from '../analysis/profit'
import type { Db } from '../db'
import { logActivity } from '../db'
import type { IntentRow } from '../types'
import { errMessage, lc, nowMs, nowSec } from '../util'
import type { Executor, TrackResult } from './service'

const PAPER_TOKEN_BASE = 9_000_000_000n

function nextPaperTokenId(db: Db): string {
  const r = db.query("SELECT value FROM kv WHERE key = 'paper.tokenSeq'").get() as { value: string } | null
  const n = r ? BigInt(JSON.parse(r.value) as string) + 1n : 1n
  db.query(
    "INSERT INTO kv (key, value, updated_ts) VALUES ('paper.tokenSeq', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts",
  ).run(JSON.stringify(n.toString()), nowMs())
  return (PAPER_TOKEN_BASE + n).toString()
}

function ledger(db: Db, kind: string, amount: bigint, c?: string, t?: string, note = '', key?: string): void {
  db.query(
    'INSERT INTO ledger (ts, kind, collection, token_id, amount, note, intent_key, paper) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(nowMs(), kind, c ?? null, t ?? null, amount.toString(), note, key ?? null)
}

function openPosition(
  db: Db, collection: string, tokenId: string, source: string, price: bigint, cost: bigint, key: string,
): void {
  db.query(
    `INSERT INTO positions (collection, token_id, source, acquired_price, acquired_cost, acquired_ts, status, paper, intent_key)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?)`,
  ).run(lc(collection), tokenId, source, price.toString(), cost.toString(), nowMs(), key)
}

function holdingOf(db: Db, collection: string, tokenId: string): { id: number; acquired_cost: string } | null {
  return db
    .query("SELECT id, acquired_cost FROM positions WHERE collection = ? AND token_id = ? AND status = 'open' AND paper = 1")
    .get(lc(collection), tokenId) as { id: number; acquired_cost: string } | null
}

function closePosition(db: Db, positionId: number, cost: bigint, grossPrice: bigint, proceeds: bigint, collection: string, tokenId: string): bigint {
  const realized = proceeds - cost
  db.query(
    "UPDATE positions SET status = 'sold', sold_price = ?, sold_net = ?, sold_ts = ?, realized = ? WHERE id = ?",
  ).run(grossPrice.toString(), proceeds.toString(), nowMs(), realized.toString(), positionId)
  ledger(db, 'sale', proceeds, collection, tokenId, `paper sale at ${grossPrice}`)
  return realized
}

export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const

  constructor(private db: Db) {}

  submit(intent: IntentRow): Promise<{ circleTxId?: string }> {
    try {
      this.apply(intent)
      return Promise.resolve({})
    } catch (e) {
      return Promise.reject(new Error(errMessage(e)))
    }
  }

  track(intent: IntentRow): Promise<TrackResult> {
    return Promise.resolve({ ok: true, txHash: `paper:${intent.key.slice(0, 24)}`, gasUsed: undefined })
  }

  private apply(intent: IntentRow): void {
    const db = this.db
    const p = intent.params
    const now = nowSec()
    const gas = intent.estCost
    const key = intent.key
    const collection = typeof p.collection === 'string' ? lc(p.collection) : intent.collection ? lc(intent.collection) : ''

    switch (intent.kind) {
      case 'mint': {
        const c = getCollection(db, collection)
        if (!c) throw new Error('unknown collection')
        const q = Number(p.quantity)
        if (now < c.mintStart || now >= c.mintEnd) throw new Error('mint window is not open')
        if (c.totalMinted + q > c.maxSupply) throw new Error('supply exhausted')
        const price = c.mintPrice * BigInt(q)
        for (let i = 0; i < q; i++) {
          const tokenId = nextPaperTokenId(db)
          openPosition(db, collection, tokenId, 'mint', c.mintPrice, c.mintPrice + gas / BigInt(q), key)
        }
        ledger(db, 'mint', -price, collection, undefined, `paper mint x${q}`, key)
        ledger(db, 'gas', -gas, collection, undefined, 'paper gas', key)
        return
      }
      case 'buy': {
        const tokenId = String(p.tokenId)
        const listing = getListing(db, collection, tokenId)
        if (!listing || (listing.expiry !== 0 && listing.expiry <= now)) throw new Error('listing is no longer active')
        if (listing.price > BigInt(String(p.maxPrice))) throw new Error('listing price is above the maximum')
        if (holdingOf(db, collection, tokenId)) throw new Error('token already held')
        openPosition(db, collection, tokenId, 'buy', listing.price, listing.price + gas, key)
        ledger(db, 'buy', -listing.price, collection, tokenId, 'paper buy', key)
        ledger(db, 'gas', -gas, collection, tokenId, 'paper gas', key)
        return
      }
      case 'list':
      case 'updateListing': {
        const tokenId = String(p.tokenId)
        if (!holdingOf(db, collection, tokenId)) throw new Error('token not held')
        const existing = db
          .query("SELECT id FROM paper_orders WHERE kind = 'listing' AND collection = ? AND token_id = ? AND status = 'active'")
          .get(collection, tokenId) as { id: number } | null
        const expiry = Number(p.expiry)
        if (existing) {
          db.query('UPDATE paper_orders SET price = ?, expiry = ?, updated_ts = ? WHERE id = ?').run(
            String(p.price), expiry, now, existing.id,
          )
        } else {
          db.query(
            `INSERT INTO paper_orders (kind, collection, token_id, collection_wide, price, expiry, status, created_ts, updated_ts)
             VALUES ('listing', ?, ?, 0, ?, ?, 'active', ?, ?)`,
          ).run(collection, tokenId, String(p.price), expiry, now, now)
        }
        ledger(db, 'gas', -gas, collection, tokenId, 'paper gas', key)
        return
      }
      case 'cancelListing': {
        db.query(
          "UPDATE paper_orders SET status = 'cancelled', updated_ts = ? WHERE kind = 'listing' AND collection = ? AND token_id = ? AND status = 'active'",
        ).run(now, collection, String(p.tokenId))
        ledger(db, 'gas', -gas, collection, String(p.tokenId), 'paper gas', key)
        return
      }
      case 'makeOffer': {
        db.query(
          `INSERT INTO paper_orders (kind, collection, token_id, collection_wide, price, expiry, status, created_ts, updated_ts)
           VALUES ('offer', ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(collection, String(p.tokenId), p.collectionWide === true ? 1 : 0, String(p.price), Number(p.expiry), now, now)
        ledger(db, 'gas', -gas, collection, undefined, 'paper gas', key)
        return
      }
      case 'updateOffer': {
        const res = db
          .query("UPDATE paper_orders SET price = ?, expiry = ?, updated_ts = ? WHERE id = ? AND kind = 'offer' AND status = 'active'")
          .run(String(p.price), Number(p.expiry), now, Number(p.offerId))
        if (res.changes === 0) throw new Error('offer is not active')
        ledger(db, 'gas', -gas, undefined, undefined, 'paper gas', key)
        return
      }
      case 'cancelOffer': {
        db.query("UPDATE paper_orders SET status = 'cancelled', updated_ts = ? WHERE id = ? AND kind = 'offer' AND status = 'active'").run(
          now, Number(p.offerId),
        )
        ledger(db, 'gas', -gas, undefined, undefined, 'paper gas', key)
        return
      }
      case 'acceptOffer': {
        const tokenId = String(p.tokenId)
        const pos = holdingOf(db, collection, tokenId)
        if (!pos) throw new Error('token not held')
        const offer = db.query("SELECT * FROM offers WHERE offer_id = ? AND status = 'active'").get(Number(p.offerId)) as {
          price: string
          expiry: number
        } | null
        if (!offer || offer.expiry <= now) throw new Error('offer is no longer active')
        const price = BigInt(offer.price)
        if (price < BigInt(String(p.minPrice))) throw new Error('offer is below the minimum price')
        const proceeds = settle(price, feesFor(db, collection)).proceeds
        closePosition(db, pos.id, BigInt(pos.acquired_cost) + gas, price, proceeds, collection, tokenId)
        ledger(db, 'gas', -gas, collection, tokenId, 'paper gas', key)
        return
      }
      case 'approveCollection':
      case 'approveUsdc':
        ledger(db, 'gas', -gas, collection || undefined, undefined, 'paper gas', key)
        return
      default:
        throw new Error(`unsupported paper action ${String(intent.kind)}`)
    }
  }

  /** Runs the fill model. Returns the number of paper orders filled or expired. */
  settleFills(settingsOutlierMad: number, includeFixtures = false): number {
    const db = this.db
    const now = nowSec()
    let n = 0
    const roles = walletRoles(db)

    const listings = db.query("SELECT * FROM paper_orders WHERE kind = 'listing' AND status = 'active'").all() as Array<{
      id: number; collection: string; token_id: string; price: string; expiry: number; created_ts: number
    }>
    const usedSales = new Set(
      (db.query('SELECT filled_sale_id FROM paper_orders WHERE filled_sale_id IS NOT NULL').all() as Array<{ filled_sale_id: number }>)
        .map((r) => r.filled_sale_id),
    )
    for (const o of listings) {
      if (o.expiry !== 0 && o.expiry <= now) {
        db.query("UPDATE paper_orders SET status = 'expired', updated_ts = ? WHERE id = ?").run(now, o.id)
        n++
        continue
      }
      const pos = holdingOf(db, o.collection, o.token_id)
      if (!pos) {
        db.query("UPDATE paper_orders SET status = 'cancelled', updated_ts = ? WHERE id = ?").run(now, o.id)
        continue
      }
      const price = BigInt(o.price)
      const { clean } = cleanSales(recentSales(db, o.collection, o.created_ts), roles, settingsOutlierMad, includeFixtures)
      const hit = clean.find((s) => !usedSales.has(s.id) && s.price >= price && s.tokenId !== o.token_id)
      if (hit) {
        usedSales.add(hit.id)
        const proceeds = settle(price, feesFor(db, o.collection)).proceeds
        const realized = closePosition(db, pos.id, BigInt(pos.acquired_cost), price, proceeds, o.collection, o.token_id)
        db.query("UPDATE paper_orders SET status = 'filled', filled_sale_id = ?, updated_ts = ? WHERE id = ?").run(hit.id, now, o.id)
        logActivity(db, { strategy: 'portfolio', message: `Paper sale filled: ${price} (realized ${realized})`, data: { collection: o.collection, tokenId: o.token_id } })
        n++
      }
    }

    const offers = db.query("SELECT * FROM paper_orders WHERE kind = 'offer' AND status = 'active'").all() as Array<{
      id: number; collection: string; token_id: string; collection_wide: number; price: string; expiry: number
    }>
    for (const o of offers) {
      if (o.expiry <= now) {
        db.query("UPDATE paper_orders SET status = 'expired', updated_ts = ? WHERE id = ?").run(now, o.id)
        n++
        continue
      }
      const bid = BigInt(o.price)
      const candidates = activeListings(db, now, o.collection)
        .filter((l) => (o.collection_wide === 1 || l.tokenId === o.token_id) && l.price <= bid && !holdingOf(db, l.collection, l.tokenId))
        .sort((a, b) => (a.price < b.price ? -1 : 1))
      const hit = candidates[0]
      if (hit) {
        openPosition(db, o.collection, hit.tokenId, 'offer', bid, bid, `paper-offer-${o.id}`)
        ledger(db, 'buy', -bid, o.collection, hit.tokenId, 'paper offer filled')
        db.query("UPDATE paper_orders SET status = 'filled', updated_ts = ? WHERE id = ?").run(now, o.id)
        logActivity(db, { strategy: 'offers', message: `Paper offer filled at ${bid}`, data: { collection: o.collection, tokenId: hit.tokenId } })
        n++
      }
    }
    return n
  }
}
