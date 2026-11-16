import { describe, expect, test } from 'bun:test'
import { minProfitablePrice } from '../src/analysis/profit'
import { PRICE_TICK } from '../src/config'
import { feesFor } from '../src/analysis/fees'
import { listIntents } from '../src/exec/intents'
import { runBuyer, scanOpportunities } from '../src/strategies/buyer'
import { runRepricer } from '../src/strategies/repricer'
import { runOffers } from '../src/strategies/offers'
import { syncPositions } from '../src/strategies/portfolio'
import { AGENT, COLL, RIVAL, RIVAL2, BUYER, BUYER2, BUYER3, U, makeCtx, makeDb, seedCollection, seedListing, seedSale, seedToken, settleIntents } from './helpers'

const SELLER = '0x00000000000000000000000000000000000000ee'
const now = () => Math.floor(Date.now() / 1000)

/** A collection with organic demand: six independent sales around 10 USDC and some listings. */
function seedMarket(db: ReturnType<typeof makeDb>) {
  seedCollection(db, COLL, { total_minted: 40, mint_price: '1000000' })
  const buyers = [BUYER, BUYER2, BUYER3]
  for (let i = 0; i < 6; i++) {
    seedSale(db, String(100 + i), buyers[i % 3], buyers[(i + 1) % 3], U(10) + BigInt(i) * 1000n, now() - 3000 + i * 10)
  }
  for (let i = 1; i <= 12; i++) seedToken(db, String(i), i % 4 === 0 ? BUYER : i % 4 === 1 ? BUYER2 : i % 4 === 2 ? BUYER3 : SELLER)
  seedListing(db, '1', SELLER, U(6), 0, COLL, now() - 10) // cheap relative to ~10 USDC fair value
  seedListing(db, '2', RIVAL, U(10), 0, COLL, now() - 10) // competitor at roughly fair value
}

describe('paper trading loop: discover -> buy -> list -> undercut -> floor', () => {
  test('buys an undervalued listing only because net profit clears the floors', async () => {
    const db = makeDb()
    seedMarket(db)
    const { ctx } = await makeCtx(db)
    const found = scanOpportunities(ctx)
    const best = found.ok[0]
    expect(best.tokenId).toBe('1')
    expect(best.profit.netProfit).toBeGreaterThan(0n)
    expect(best.profit.netProfit).toBeLessThan(best.expectedResale - best.price) // net < gross spread

    await runBuyer(ctx)
    await settleIntents(db)
    const bought = listIntents(db, ['confirmed']).filter((i) => i.kind === 'buy')
    expect(bought.length).toBe(1)
    expect(ctx.own.holdings().map((h) => h.tokenId)).toEqual(['1'])
  })

  test('does not buy a merely cheap listing when the resale is not profitable', async () => {
    const db = makeDb()
    seedMarket(db)
    // Cheap by 5% only: the spread cannot cover fees, royalty and gas.
    db.query("UPDATE listings SET price = ? WHERE token_id = '1'").run(U(9.6).toString())
    const { ctx } = await makeCtx(db)
    expect(scanOpportunities(ctx).ok.length).toBe(0)
    await runBuyer(ctx)
    await settleIntents(db)
    expect(listIntents(db).filter((i) => i.kind === 'buy').length).toBe(0)
  })

  test('refuses listings with no independent demand (wash-traded history)', async () => {
    const db = makeDb()
    seedCollection(db, COLL, { total_minted: 40 })
    for (let i = 0; i < 6; i++) seedSale(db, String(100 + i), RIVAL, RIVAL2, U(10), now() - 3000 + i) // fixtures trading with each other
    seedListing(db, '1', SELLER, U(4), 0, COLL, now() - 10)
    const { ctx } = await makeCtx(db)
    await runBuyer(ctx)
    await settleIntents(db)
    expect(listIntents(db).filter((i) => i.kind === 'buy').length).toBe(0)
  })

  test('lists below the lowest comparable, follows undercuts, and stops at the minimum profitable price', async () => {
    const db = makeDb()
    seedMarket(db)
    const t = await makeCtx(db)
    const { ctx } = t
    await runBuyer(ctx)
    await settleIntents(db)
    const h = ctx.own.holdings()[0]
    expect(h.tokenId).toBe('1')

    // 1) First listing: one tick under the rival at 10.000.
    await runRepricer(ctx)
    await settleIntents(db)
    expect(ctx.own.listingOf(COLL, '1')?.price).toBe(U(10) - PRICE_TICK)

    // 2) Rival undercuts to 9.5 -> we follow to 9.499.
    seedListing(db, '2', RIVAL, U(9.5), 0, COLL, now())
    db.query('DELETE FROM reprices').run()
    await runRepricer(ctx)
    await settleIntents(db)
    expect(ctx.own.listingOf(COLL, '1')?.price).toBe(U(9.5) - PRICE_TICK)

    // 3) Rival crashes the price below what we can profitably sell at: we stop at the floor.
    const fees = feesFor(db, COLL)
    const sunk = h.acquiredCost + ctx.gas.costUsdc('list') + ctx.gas.costUsdc('updateListing', 2)
    const settings = ctx.getSettings()
    const floor = minProfitablePrice(sunk, fees, settings.risk.minNetProfit, BigInt(settings.risk.minRoiBps))
    expect(floor).toBeGreaterThan(h.acquiredCost)
    seedListing(db, '2', RIVAL, floor - PRICE_TICK * 50n, 0, COLL, now())
    db.query('DELETE FROM reprices').run()
    await runRepricer(ctx)
    await settleIntents(db)
    const atFloor = ctx.own.listingOf(COLL, '1')?.price as bigint
    expect(atFloor).toBe(floor)
    expect(atFloor).toBeGreaterThan(h.acquiredCost)

    // 4) Rival drops even lower: nothing below the floor is ever submitted.
    seedListing(db, '2', RIVAL, floor - PRICE_TICK * 400n, 0, COLL, now())
    db.query('DELETE FROM reprices').run()
    await runRepricer(ctx)
    await settleIntents(db)
    const after = ctx.own.listingOf(COLL, '1')?.price as bigint
    expect(after).toBe(atFloor) // never lower, and the gas budget means the floor does not creep
    // Once at the floor, further undercuts by the rival produce no action at all.
    db.query('DELETE FROM reprices').run()
    const before = listIntents(db).length
    await runRepricer(ctx)
    await settleIntents(db)
    expect(ctx.own.listingOf(COLL, '1')?.price).toBe(after)
    expect(listIntents(db).length).toBe(before)
  })

  test("the agent's own listings are ignored when looking for the lowest competitor", async () => {
    const db = makeDb()
    seedMarket(db)
    const { ctx } = await makeCtx(db)
    await runBuyer(ctx)
    await settleIntents(db)
    await runRepricer(ctx)
    await settleIntents(db)
    const own = ctx.own.listingOf(COLL, '1')?.price as bigint
    db.query('DELETE FROM reprices').run()
    // Simulate our own paper listing also being visible as a market row: it must not make us undercut ourselves.
    seedListing(db, '1', AGENT, own, 0, COLL, now())
    await runRepricer(ctx)
    await settleIntents(db)
    expect(ctx.own.listingOf(COLL, '1')?.price).toBe(own)
  })
})

describe('offer management in paper mode', () => {
  test('opens a bid below fair value and counters a rival within the profitable ceiling', async () => {
    const db = makeDb()
    seedMarket(db)
    db.query("UPDATE listings SET price = ? WHERE token_id = '1'").run(U(11).toString())
    db.query("UPDATE listings SET price = ? WHERE token_id = '2'").run(U(10.5).toString())
    const { ctx } = await makeCtx(db, { risk: { minNetProfit: '200000', minRoiBps: 100 } })
    await runOffers(ctx)
    await settleIntents(db)
    const first = ctx.own.offers()[0]
    expect(first).toBeDefined()
    expect(first.price).toBeLessThan(U(10))

    // A rival bids above us; we counter by one increment but never beyond the ceiling.
    db.query(
      "INSERT INTO offers (offer_id, collection, token_id, collection_wide, bidder, price, expiry, status, created_ts, updated_ts) VALUES (500, ?, '0', 1, ?, ?, ?, 'active', ?, ?)",
    ).run(COLL, RIVAL, (first.price + PRICE_TICK * 3n).toString(), now() + 3600, now(), now())
    db.query("UPDATE intents SET updated_ts = 1 WHERE kind = 'makeOffer'").run()
    await runOffers(ctx)
    await settleIntents(db)
    const countered = ctx.own.offers()[0]
    expect(countered.price).toBe(first.price + PRICE_TICK * 4n)

    // A rival bids absurdly high: we do not follow, and release the capital.
    db.query("UPDATE offers SET price = ? WHERE offer_id = 500").run(U(9.9).toString())
    db.query("UPDATE intents SET updated_ts = 1 WHERE kind IN ('makeOffer','updateOffer')").run()
    await runOffers(ctx)
    await settleIntents(db)
    expect(ctx.own.offers().length).toBe(0)
  })
})

describe('live-mode position reconciliation', () => {
  test('opens a position for a token the agent owns and closes it with the realised result when sold', async () => {
    const db = makeDb()
    seedMarket(db)
    const liveCtx = (await makeCtx(db, { mode: 'testnet-live' })).ctx
    seedToken(db, '7', AGENT)
    seedSale(db, '7', SELLER, AGENT, U(6), now() - 100)
    expect(syncPositions(liveCtx).opened).toBe(1)
    const pos = db.query("SELECT * FROM positions WHERE token_id = '7'").get() as { acquired_price: string; status: string }
    expect(pos.acquired_price).toBe(U(6).toString())
    // Sold to someone else.
    db.query("UPDATE tokens SET owner = ? WHERE token_id = '7'").run(BUYER)
    db.query("INSERT INTO sales (collection, token_id, seller, buyer, price, fee, royalty, kind, ts, block, tx_hash, log_index) VALUES (?, '7', ?, ?, ?, ?, ?, 0, ?, 9, '0xsold', 0)").run(
      COLL, AGENT, BUYER, U(8).toString(), U(0.2).toString(), U(0.4).toString(), now(),
    )
    expect(syncPositions(liveCtx).closed).toBe(1)
    const closed = db.query("SELECT * FROM positions WHERE token_id = '7'").get() as { status: string; realized: string; sold_net: string }
    expect(closed.status).toBe('sold')
    expect(BigInt(closed.sold_net)).toBe(U(8) - U(0.2) - U(0.4))
    expect(BigInt(closed.realized)).toBe(U(7.4) - U(6))
  })
})
