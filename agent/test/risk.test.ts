import { describe, expect, test } from 'bun:test'
import type { CollectionRow, CollectionStats, WalletRole } from '../src/analysis/market'
import type { CollectionScore } from '../src/analysis/scoring'
import { checkRisk, collectionExposure, recordSpend, refundSpend, spendTotals, type RiskInput } from '../src/risk/engine'
import type { Action } from '../src/types'
import { AGENT, COLL, RIVAL, U, makeDb, seedCollection, settingsWith } from './helpers'

const collection: CollectionRow = {
  address: COLL, creator: RIVAL, name: 'Test', symbol: 'T', mintPrice: U(1), maxSupply: 1000, maxPerWallet: 10, mintStart: 1, mintEnd: 2,
  royaltyBps: 500, createdTs: 1, totalMinted: 50, revealed: false, verified: true,
}
const stats: CollectionStats = {
  collection: COLL, floor: U(10), floorTokenId: '1', activeListings: 5, salesCount: 6, excludedSales: 0, uniqueBuyers: 4, uniqueSellers: 3,
  volume: U(60), medianPrice: U(10), lastSalePrice: U(10), lastSaleTs: 1, fairValue: U(10), confidence: 0.7, bestCollectionOffer: null,
  holders: 12, topHolderShareBps: 1500, dataAgeSec: 5,
}
const score: CollectionScore = { collection: COLL, score: 72, rawPoints: 50, coverage: 0.7, components: [] }

function buyAction(price = U(5)): Action {
  return {
    key: 'buy:1', kind: 'buy', strategy: 'buy', collection: COLL, tokenId: '1', params: {}, spend: price, gasEstimate: U(0.02), summary: 'buy',
  }
}

function good(over: Partial<RiskInput> = {}): RiskInput {
  return {
    settings: settingsWith(), now: 1000, action: buyAction(), collection, stats, score,
    analysis: { ok: true, netProfit: U(2), roiBps: 2000n, reasons: [] }, gasCost: U(0.02), priceObservedAt: 995,
    fairValue: U(10), fairValueConfidence: 0.7, unitPrice: U(5), counterparty: '0x00000000000000000000000000000000000000ee',
    roles: new Map<string, WalletRole>([[AGENT, 'agent']]), agent: AGENT,
    exposure: { collectionCommitted: 0n, collectionTokens: 0, totalCapital: U(500), openOfferCapital: 0n },
    spent: { day: 0n, week: 0n }, ...over,
  }
}

const codes = (i: RiskInput) => checkRisk(i).map((v) => v.code)

describe('risk gate', () => {
  test('a healthy purchase passes', () => {
    expect(codes(good())).toEqual([])
  })
  test('global pause blocks everything', () => {
    expect(codes(good({ settings: settingsWith({ paused: true }) }))).toContain('paused')
  })
  test('disabled strategy blocks', () => {
    expect(codes(good({ settings: settingsWith({ strategies: { buy: false } }) }))).toContain('strategy-disabled')
  })
  test('unprofitable trade blocks', () => {
    expect(codes(good({ analysis: { ok: false, netProfit: -1n, roiBps: -10n, reasons: ['negative'] } }))).toContain('unprofitable')
    expect(codes(good({ analysis: null }))).toContain('no-analysis')
  })
  test('max purchase price', () => {
    expect(codes(good({ unitPrice: U(25), action: buyAction(U(25)) }))).toContain('price-too-high')
  })
  test('max mint price', () => {
    const mint: Action = { ...buyAction(U(9)), kind: 'mint', key: 'm1' }
    expect(codes(good({ action: mint, unitPrice: U(9) }))).toContain('mint-price-too-high')
  })
  test('daily and weekly spend limits', () => {
    expect(codes(good({ spent: { day: U(48), week: U(48) } }))).toContain('daily-limit')
    expect(codes(good({ spent: { day: 0n, week: U(198) } }))).toContain('weekly-limit')
  })
  test('per-collection exposure cap and token cap', () => {
    expect(codes(good({ exposure: { collectionCommitted: U(58), collectionTokens: 1, totalCapital: U(5000), openOfferCapital: 0n } }))).toContain('exposure-cap')
    expect(codes(good({ exposure: { collectionCommitted: 0n, collectionTokens: 10, totalCapital: U(5000), openOfferCapital: 0n } }))).toContain('token-cap')
  })
  test('portfolio allocation cap', () => {
    expect(codes(good({ exposure: { collectionCommitted: U(20), collectionTokens: 2, totalCapital: U(50), openOfferCapital: 0n } }))).toContain('allocation-cap')
  })
  test('minimum liquidity', () => {
    expect(codes(good({ stats: { ...stats, salesCount: 1 } }))).toContain('illiquid')
    expect(codes(good({ stats: { ...stats, uniqueBuyers: 1 } }))).toContain('illiquid')
  })
  test('stale price evidence', () => {
    expect(codes(good({ priceObservedAt: 100 }))).toContain('stale-price')
  })
  test('suspiciously cheap listing and weak valuation are treated as manipulation risk', () => {
    expect(codes(good({ unitPrice: U(1), action: buyAction(U(1)) }))).toContain('suspiciously-cheap')
    expect(codes(good({ fairValueConfidence: 0.05 }))).toContain('low-confidence-valuation')
  })
  test('collection score threshold and coverage', () => {
    expect(codes(good({ score: { ...score, score: 30 } }))).toContain('score-below-threshold')
    expect(codes(good({ score: { ...score, coverage: 0.2 } }))).toContain('score-below-threshold')
  })
  test('blocklist, allowlist and unverified contracts', () => {
    expect(codes(good({ settings: settingsWith({ risk: { blocklist: [COLL] } }) }))).toContain('blocklisted')
    expect(codes(good({ settings: settingsWith({ risk: { allowlist: ['0x00000000000000000000000000000000000000aa'] } }) }))).toContain('not-allowlisted')
    expect(codes(good({ collection: { ...collection, verified: false } }))).toContain('unverified-contract')
  })
  test('gas ceiling', () => {
    expect(codes(good({ gasCost: U(5) }))).toContain('gas-too-high')
  })
  test('never trades with wallets controlled by the same operator unless explicitly allowed', () => {
    const fixture = '0x00000000000000000000000000000000000000c1'
    const roles = new Map<string, WalletRole>([[fixture, 'fixture'], [AGENT, 'agent']])
    expect(codes(good({ roles, counterparty: fixture }))).toContain('related-counterparty')
    expect(codes(good({ roles, counterparty: AGENT }))).toContain('self-trade')
    expect(codes(good({ roles, counterparty: fixture, settings: settingsWith({ risk: { allowFixtureCounterparties: true } }) }))).not.toContain('related-counterparty')
  })
  test('listings below the minimum profitable price are refused', () => {
    const list: Action = { ...buyAction(0n), kind: 'list', key: 'l1', spend: 0n }
    expect(codes(good({ action: list, minListPrice: U(10), listPrice: U(9.999) }))).toContain('below-min-profitable')
    expect(codes(good({ action: list, minListPrice: U(10), listPrice: U(10) }))).toEqual([])
  })
  test('offers: capital in open offers is capped; lowering an offer is always allowed', () => {
    const offer: Action = { ...buyAction(U(30)), kind: 'makeOffer', key: 'o1', spend: U(30) }
    expect(codes(good({ action: offer, unitPrice: U(15), exposure: { collectionCommitted: 0n, collectionTokens: 0, totalCapital: U(5000), openOfferCapital: U(20) } }))).toContain('offer-capital-cap')
    const lower: Action = { ...buyAction(0n), kind: 'updateOffer', key: 'o2', spend: 0n }
    expect(codes(good({ action: lower, analysis: null, score: null, stats: null }))).toEqual([])
  })
})

describe('spend accounting', () => {
  test('records, totals and refunds spend', () => {
    const db = makeDb()
    recordSpend(db, 'k1', 'buy', U(5), COLL)
    recordSpend(db, 'k2', 'mint', U(3), COLL)
    recordSpend(db, 'k1', 'buy', U(5), COLL) // idempotent per intent key
    expect(spendTotals(db, Math.floor(Date.now() / 1000)).day).toBe(U(8))
    refundSpend(db, 'k1')
    expect(spendTotals(db, Math.floor(Date.now() / 1000)).day).toBe(U(3))
  })
  test('exposure counts open positions, own offers and in-flight buys', () => {
    const db = makeDb()
    seedCollection(db)
    db.query("INSERT INTO positions (collection, token_id, source, acquired_price, acquired_cost, acquired_ts, status, paper) VALUES (?, '1', 'buy', '5000000', '5100000', 1, 'open', 0)").run(COLL)
    db.query("INSERT INTO offers (offer_id, collection, token_id, collection_wide, bidder, price, expiry, status, created_ts, updated_ts) VALUES (1, ?, '0', 1, ?, '2000000', 99999999999, 'active', 1, 1)").run(COLL, AGENT)
    db.query(
      "INSERT INTO intents (key, kind, strategy, params, status, mode, collection, spend, created_ts, updated_ts) VALUES ('x', 'buy', 'buy', '{}', 'pending', 'paper', ?, '3000000', 1, 1)",
    ).run(COLL)
    const e = collectionExposure(db, COLL, AGENT, 1000)
    expect(e.committed).toBe(U(5.1) + U(2) + U(3))
    expect(e.tokens).toBe(2)
    expect(e.openOfferCapital).toBe(U(2))
  })
})
