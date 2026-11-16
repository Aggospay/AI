import { describe, expect, test } from 'bun:test'
import { applyLog, type DecodedLog } from '../src/chain/reducer'
import { AGENT, BUYER, COLL, FACTORY, RIVAL, makeDb } from './helpers'

const ZERO = '0x0000000000000000000000000000000000000000'
let n = 0
const log = (name: string, address: string, args: Record<string, unknown>, block = 10): DecodedLog => ({
  block, logIndex: n++, txHash: `0x${n.toString(16)}`, address, name, args, ts: 1000 + block,
})

const created = (): DecodedLog => log('CollectionCreated', FACTORY, {
  collection: COLL, creator: RIVAL, name: 'Apes', symbol: 'APE', mintPrice: 1_000_000n, maxSupply: 100, maxPerWallet: 5,
  mintStart: 1, royaltyBps: 500n, seedCommitment: '0x' + '22'.repeat(32), mintEnd: 99999,
})

describe('projection reducer', () => {
  test('is idempotent: replaying the same logs changes nothing', () => {
    const db = makeDb()
    const logs = [
      created(),
      log('Transfer', COLL, { from: ZERO, to: RIVAL, tokenId: 1n }),
      log('Listed', 'market', { collection: COLL, tokenId: 1n, seller: RIVAL, price: 5_000_000n, expiry: 0n }),
    ]
    for (const l of logs) expect(applyLog(db, l, FACTORY).applied).toBe(true)
    for (const l of logs) expect(applyLog(db, l, FACTORY).applied).toBe(false)
    expect((db.query('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n).toBe(1)
    expect((db.query('SELECT total_minted AS n FROM collections').get() as { n: number }).n).toBe(1)
  })

  test('ignores a CollectionCreated that did not come from the trusted factory', () => {
    const db = makeDb()
    const evil = { ...created(), address: '0x00000000000000000000000000000000000000ba' }
    applyLog(db, evil, FACTORY)
    expect((db.query('SELECT COUNT(*) AS n FROM collections').get() as { n: number }).n).toBe(0)
  })

  test('a transfer invalidates the previous owner\'s listing', () => {
    const db = makeDb()
    applyLog(db, created(), FACTORY)
    applyLog(db, log('Transfer', COLL, { from: ZERO, to: RIVAL, tokenId: 1n }), FACTORY)
    applyLog(db, log('Listed', 'm', { collection: COLL, tokenId: 1n, seller: RIVAL, price: 5_000_000n, expiry: 0n }), FACTORY)
    applyLog(db, log('Transfer', COLL, { from: RIVAL, to: BUYER, tokenId: 1n }), FACTORY)
    const row = db.query('SELECT status FROM listings').get() as { status: string }
    expect(row.status).toBe('stale')
  })

  test('sale marks the listing sold and records the trade; offers track their lifecycle', () => {
    const db = makeDb()
    applyLog(db, created(), FACTORY)
    applyLog(db, log('Listed', 'm', { collection: COLL, tokenId: 1n, seller: RIVAL, price: 5_000_000n, expiry: 0n }), FACTORY)
    applyLog(db, log('Sale', 'm', { collection: COLL, tokenId: 1n, seller: RIVAL, buyer: AGENT, price: 5_000_000n, fee: 125_000n, royalty: 250_000n, kind: 0 }), FACTORY)
    expect((db.query('SELECT status FROM listings').get() as { status: string }).status).toBe('sold')
    expect((db.query('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(1)

    applyLog(db, log('OfferMade', 'm', { offerId: 1n, collection: COLL, bidder: AGENT, tokenId: 0n, collectionWide: true, price: 3_000_000n, expiry: 5000n }), FACTORY)
    applyLog(db, log('OfferUpdated', 'm', { offerId: 1n, oldPrice: 3_000_000n, newPrice: 3_100_000n, newExpiry: 6000n }), FACTORY)
    expect((db.query('SELECT price FROM offers').get() as { price: string }).price).toBe('3100000')
    applyLog(db, log('OfferCancelled', 'm', { offerId: 1n, bidder: AGENT, refund: 3_100_000n, expiredReclaim: false }), FACTORY)
    expect((db.query('SELECT status FROM offers').get() as { status: string }).status).toBe('cancelled')
  })

  test('an obsolete-listing cancellation event cannot cancel the new owner\'s listing', () => {
    const db = makeDb()
    applyLog(db, created(), FACTORY)
    applyLog(db, log('Listed', 'm', { collection: COLL, tokenId: 1n, seller: RIVAL, price: 5_000_000n, expiry: 0n }), FACTORY)
    applyLog(db, log('Listed', 'm', { collection: COLL, tokenId: 1n, seller: AGENT, price: 4_000_000n, expiry: 0n }), FACTORY)
    applyLog(db, log('ListingCancelled', 'm', { collection: COLL, tokenId: 1n, seller: RIVAL, byAnyone: true }), FACTORY)
    const row = db.query('SELECT seller, status FROM listings').get() as { seller: string; status: string }
    expect(row.seller).toBe(AGENT)
    expect(row.status).toBe('active')
  })
})
