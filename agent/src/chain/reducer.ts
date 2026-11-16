/**
 * Idempotent projection reducer. Applies one decoded log to the SQLite projections.
 * Safe to call twice for the same log (the events table guards with a unique key) and
 * tolerant of cross-contract ordering inside a block range.
 */
import type { Db } from '../db'
import { toJson } from '../util'

export interface DecodedLog {
  block: number
  logIndex: number
  txHash: string
  address: string
  name: string
  args: Record<string, unknown>
  ts: number
}

const ZERO = '0x0000000000000000000000000000000000000000'
const s = (v: unknown): string => String(v).toLowerCase()
const n = (v: unknown): number => Number(v)

export interface ReduceResult {
  applied: boolean
  touched: Array<{ collection: string; tokenId?: string }>
  newCollection?: string
}

/** Persist raw event and update projections. Returns whether the log was new. */
export function applyLog(db: Db, log: DecodedLog, factory: string | undefined): ReduceResult {
  const result: ReduceResult = { applied: false, touched: [] }
  const insert = db
    .query(
      'INSERT OR IGNORE INTO events (block, log_index, tx_hash, address, name, args, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(log.block, log.logIndex, log.txHash, s(log.address), log.name, toJson(log.args), log.ts)
  if (insert.changes === 0) return result
  result.applied = true

  const a = log.args
  switch (log.name) {
    case 'CollectionCreated': {
      if (factory && s(log.address) !== s(factory)) break // only trust our factory
      db.query(
        `INSERT OR IGNORE INTO collections (address, creator, name, symbol, mint_price, max_supply, max_per_wallet,
          mint_start, mint_end, royalty_bps, seed_commitment, created_block, created_ts, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        s(a.collection), s(a.creator), String(a.name), String(a.symbol), String(a.mintPrice), n(a.maxSupply),
        n(a.maxPerWallet), n(a.mintStart), n(a.mintEnd), n(a.royaltyBps), String(a.seedCommitment), log.block, log.ts,
      )
      result.newCollection = s(a.collection)
      result.touched.push({ collection: s(a.collection) })
      break
    }
    case 'Transfer': {
      const collection = s(log.address)
      const known = db.query('SELECT 1 FROM collections WHERE address = ?').get(collection)
      if (!known) break
      const tokenId = String(a.tokenId)
      const to = s(a.to)
      if (s(a.from) === ZERO) {
        db.query(
          `INSERT INTO tokens (collection, token_id, owner, minter, minted_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(collection, token_id) DO UPDATE SET owner = excluded.owner, updated_ts = excluded.updated_ts`,
        ).run(collection, tokenId, to, to, log.ts, log.ts)
        db.query('UPDATE collections SET total_minted = total_minted + 1 WHERE address = ?').run(collection)
      } else {
        db.query(
          `INSERT INTO tokens (collection, token_id, owner, updated_ts) VALUES (?, ?, ?, ?)
           ON CONFLICT(collection, token_id) DO UPDATE SET owner = excluded.owner, updated_ts = excluded.updated_ts`,
        ).run(collection, tokenId, to, log.ts)
        // A transfer invalidates the previous owner's listing.
        db.query(
          "UPDATE listings SET status = 'stale', updated_ts = ? WHERE collection = ? AND token_id = ? AND status = 'active' AND seller != ?",
        ).run(log.ts, collection, tokenId, to)
      }
      result.touched.push({ collection, tokenId })
      break
    }
    case 'Revealed': {
      db.query('UPDATE collections SET revealed = 1 WHERE address = ?').run(s(log.address))
      result.touched.push({ collection: s(log.address) })
      break
    }
    case 'Listed': {
      const c = s(a.collection)
      const t = String(a.tokenId)
      db.query(
        `INSERT INTO listings (collection, token_id, seller, price, expiry, status, listed_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(collection, token_id) DO UPDATE SET seller = excluded.seller, price = excluded.price,
           expiry = excluded.expiry, status = 'active', listed_ts = excluded.listed_ts, updated_ts = excluded.updated_ts`,
      ).run(c, t, s(a.seller), String(a.price), n(a.expiry), log.ts, log.ts)
      result.touched.push({ collection: c, tokenId: t })
      break
    }
    case 'ListingUpdated': {
      const c = s(a.collection)
      const t = String(a.tokenId)
      db.query(
        "UPDATE listings SET price = ?, expiry = ?, status = 'active', updated_ts = ? WHERE collection = ? AND token_id = ?",
      ).run(String(a.newPrice), n(a.newExpiry), log.ts, c, t)
      result.touched.push({ collection: c, tokenId: t })
      break
    }
    case 'ListingCancelled': {
      const c = s(a.collection)
      const t = String(a.tokenId)
      // A newer Listed by another seller must not be cancelled by an obsolete-listing event.
      db.query(
        "UPDATE listings SET status = 'cancelled', updated_ts = ? WHERE collection = ? AND token_id = ? AND seller = ? AND status = 'active'",
      ).run(log.ts, c, t, s(a.seller))
      result.touched.push({ collection: c, tokenId: t })
      break
    }
    case 'Sale': {
      const c = s(a.collection)
      const t = String(a.tokenId)
      db.query(
        `INSERT OR IGNORE INTO sales (collection, token_id, seller, buyer, price, fee, royalty, kind, ts, block, tx_hash, log_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        c, t, s(a.seller), s(a.buyer), String(a.price), String(a.fee), String(a.royalty), n(a.kind),
        log.ts, log.block, log.txHash, log.logIndex,
      )
      db.query(
        "UPDATE listings SET status = 'sold', updated_ts = ? WHERE collection = ? AND token_id = ? AND status = 'active'",
      ).run(log.ts, c, t)
      result.touched.push({ collection: c, tokenId: t })
      break
    }
    case 'OfferMade': {
      db.query(
        `INSERT OR REPLACE INTO offers (offer_id, collection, token_id, collection_wide, bidder, price, expiry, status, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        n(a.offerId), s(a.collection), String(a.tokenId), a.collectionWide ? 1 : 0, s(a.bidder), String(a.price),
        n(a.expiry), log.ts, log.ts,
      )
      result.touched.push({ collection: s(a.collection), tokenId: a.collectionWide ? undefined : String(a.tokenId) })
      break
    }
    case 'OfferUpdated': {
      db.query('UPDATE offers SET price = ?, expiry = ?, updated_ts = ? WHERE offer_id = ?').run(
        String(a.newPrice), n(a.newExpiry), log.ts, n(a.offerId),
      )
      const row = db.query('SELECT collection FROM offers WHERE offer_id = ?').get(n(a.offerId)) as
        | { collection: string }
        | null
      if (row) result.touched.push({ collection: row.collection })
      break
    }
    case 'OfferCancelled': {
      db.query("UPDATE offers SET status = ?, updated_ts = ? WHERE offer_id = ?").run(
        a.expiredReclaim ? 'expired' : 'cancelled', log.ts, n(a.offerId),
      )
      const row = db.query('SELECT collection FROM offers WHERE offer_id = ?').get(n(a.offerId)) as
        | { collection: string }
        | null
      if (row) result.touched.push({ collection: row.collection })
      break
    }
    case 'OfferAccepted': {
      db.query("UPDATE offers SET status = 'filled', updated_ts = ? WHERE offer_id = ?").run(log.ts, n(a.offerId))
      result.touched.push({ collection: s(a.collection), tokenId: String(a.tokenId) })
      break
    }
    default:
      break
  }
  return result
}
