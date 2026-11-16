import { describe, expect, test } from 'bun:test'
import { cleanSales, collectionStats, rarityTable, recentSales, walletRoles } from '../src/analysis/market'
import { scoreCollection } from '../src/analysis/scoring'
import { getCollection } from '../src/analysis/market'
import { AGENT, BUYER, BUYER2, BUYER3, COLL, RIVAL, RIVAL2, U, makeDb, seedCollection, seedListing, seedSale, seedToken, settingsWith } from './helpers'

const NOW = 1_000_000

describe('sales hygiene (anti-manipulation)', () => {
  test('self trades, fixture trades and related-wallet trades never count as demand', () => {
    const db = makeDb()
    seedCollection(db)
    seedSale(db, '1', BUYER, BUYER, U(100), NOW - 100) // self trade
    seedSale(db, '2', RIVAL, BUYER, U(100), NOW - 90) // fixture seller
    seedSale(db, '3', BUYER, RIVAL2, U(100), NOW - 80) // fixture buyer
    const TREASURY = '0x00000000000000000000000000000000000000f9'
    db.query("INSERT INTO wallets (address, label, role) VALUES (?, 'treasury', 'treasury')").run(TREASURY)
    seedSale(db, '4', AGENT, TREASURY, U(100), NOW - 70) // related wallets (agent and treasury, same operator)
    seedSale(db, '5', BUYER, BUYER2, U(10), NOW - 60) // genuine
    const { clean, excluded } = cleanSales(recentSales(db, COLL, 0), walletRoles(db), 4)
    expect(clean.map((s) => s.tokenId)).toEqual(['5'])
    expect(excluded.map((e) => e.reason).sort()).toEqual(['fixture', 'fixture', 'related-wallets', 'self-trade'])
  })
  test('A to B then B to A round trips are excluded', () => {
    const db = makeDb()
    seedCollection(db)
    seedSale(db, '1', BUYER, BUYER2, U(50), NOW - 500)
    seedSale(db, '1', BUYER2, BUYER, U(51), NOW - 400)
    seedSale(db, '2', BUYER3, BUYER, U(10), NOW - 300)
    const { clean, excluded } = cleanSales(recentSales(db, COLL, 0), walletRoles(db), 4)
    expect(clean.map((s) => s.tokenId)).toEqual(['2'])
    expect(excluded.every((e) => e.reason === 'round-trip')).toBe(true)
  })
  test('statistical outliers are removed once there are enough samples', () => {
    const db = makeDb()
    seedCollection(db)
    for (let i = 0; i < 6; i++) seedSale(db, String(i), BUYER, BUYER2, U(10) + BigInt(i) * 1000n, NOW - 1000 + i)
    seedSale(db, '99', BUYER3, BUYER, U(500), NOW - 10) // wildly off
    const { clean, excluded } = cleanSales(recentSales(db, COLL, 0), walletRoles(db), 4)
    expect(excluded.map((e) => e.reason)).toEqual(['outlier'])
    expect(clean.length).toBe(6)
  })
})

describe('collection statistics and fair value', () => {
  test('fair value is the median of clean sales and ignores wash trades', () => {
    const db = makeDb()
    seedCollection(db)
    const s = settingsWith({ risk: { minLiquidityWindowSec: 86_400 } })
    const now = Math.floor(Date.now() / 1000)
    seedSale(db, '1', BUYER, BUYER2, U(10), now - 300)
    seedSale(db, '2', BUYER2, BUYER3, U(12), now - 200)
    seedSale(db, '3', BUYER3, BUYER, U(11), now - 100)
    seedSale(db, '4', RIVAL, RIVAL2, U(1000), now - 50) // wash trade between fixtures
    const stats = collectionStats(db, COLL, s, now)
    expect(stats.fairValue).toBe(U(11))
    expect(stats.salesCount).toBe(3)
    expect(stats.excludedSales).toBe(1)
    expect(stats.uniqueBuyers).toBe(3)
  })
  test('floor ignores expired listings; with no sales fair value falls back to floor with low confidence', () => {
    const db = makeDb()
    seedCollection(db)
    const now = Math.floor(Date.now() / 1000)
    seedListing(db, '1', RIVAL, U(5), now - 10) // expired
    seedListing(db, '2', RIVAL, U(8))
    const stats = collectionStats(db, COLL, settingsWith(), now)
    expect(stats.floor).toBe(U(8))
    expect(stats.fairValue).toBe(U(8))
    expect(stats.confidence).toBeLessThan(0.2)
  })
  test('rarity ranks rarer trait combinations higher and reports tiers', () => {
    const db = makeDb()
    seedCollection(db)
    for (let i = 1; i <= 20; i++) seedToken(db, String(i), BUYER, 0x00000000) // all common
    seedToken(db, '21', BUYER, 0x04040404) // very rare on every slot
    const t = rarityTable(db, COLL)
    expect(t.get('21')?.tier).toBe(0)
    expect(t.get('1')?.tier).toBeGreaterThanOrEqual(2)
  })
})

describe('collection score', () => {
  test('unscored components are reported and coverage is below 100%', () => {
    const db = makeDb()
    seedCollection(db)
    const c = getCollection(db, COLL)!
    const now = Math.floor(Date.now() / 1000)
    seedSale(db, '1', BUYER, BUYER2, U(1.5), now - 100)
    const stats = collectionStats(db, COLL, settingsWith(), now)
    const score = scoreCollection(c, stats, 0)
    const team = score.components.find((x) => x.name === 'Team credibility')!
    expect(team.points).toBeNull()
    expect(score.coverage).toBeLessThan(1)
    expect(score.score).toBeGreaterThanOrEqual(0)
    expect(score.score).toBeLessThanOrEqual(100)
  })
  test('an unverified contract loses its security points', () => {
    const db = makeDb()
    seedCollection(db, COLL, { verified: 0 })
    const c = getCollection(db, COLL)!
    const stats = collectionStats(db, COLL, settingsWith(), Math.floor(Date.now() / 1000))
    const sec = scoreCollection(c, stats, 0).components.find((x) => x.name === 'Contract and security')!
    expect(sec.points).toBeLessThanOrEqual(4)
  })
})
