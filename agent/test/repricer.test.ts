import { describe, expect, test } from 'bun:test'
import { defaultSettings, PRICE_TICK } from '../src/config'
import { minProfitablePrice } from '../src/analysis/profit'
import { comparableListings, type ListingRow, type RarityInfo } from '../src/analysis/market'
import { decideListing, type DecideInput } from '../src/strategies/repricer'
import { AGENT, COLL, RIVAL, RIVAL2, U } from './helpers'

const fees = { marketFeeBps: 250n, royaltyBps: 500n }
const pricing = { ...defaultSettings().pricing, repriceCooldownSec: 60, maxRepricesPerHour: 10 }

// Acquisition cost chosen so the minimum profitable price is exactly known.
const sunk = U(0.4)
const MIN = minProfitablePrice(sunk, fees, U(0.02), 0n)

function input(over: Partial<DecideInput>): DecideInput {
  return {
    now: 100_000, sunkCost: sunk, fees, minNetProfit: U(0.02), minRoiBps: 0n, current: null, lowestComparable: null,
    fairValue: null, pricing, lastRepriceTs: null, repricesLastHour: 0, repricesLast15m: 0, bestOffer: null, heldSec: 100, ...over,
  }
}

describe('undercut ladder (spec example)', () => {
  test('lists one tick below the lowest comparable competitor', () => {
    const d = decideListing(input({ lowestComparable: U(0.5) }))
    expect(d.kind).toBe('list')
    expect(d.price).toBe(U(0.5) - PRICE_TICK) // 0.499
  })

  test('follows the competitor down: 0.50 -> 0.48 becomes 0.479', () => {
    const d = decideListing(input({ current: { price: U(0.499), expiry: 0 }, lowestComparable: U(0.48), lastRepriceTs: 100_000 - 3600 }))
    expect(d.kind).toBe('reprice')
    expect(d.price).toBe(U(0.479))
  })

  test('stops lowering when the next undercut would be unprofitable and waits at the minimum price', () => {
    expect(MIN).toBeGreaterThan(U(0.449)) // sanity: costs make 0.449 unprofitable
    // Competitor drops to just above the floor: target (competitor - tick) is below MIN.
    const d = decideListing(input({ current: { price: U(0.479), expiry: 0 }, lowestComparable: MIN, lastRepriceTs: 0 }))
    expect(d.kind).toBe('reprice')
    expect(d.price).toBe(MIN)
    expect(d.atFloor).toBe(true)
    // Already sitting at the floor while the competitor stays below: hold, do not go lower.
    const hold = decideListing(input({ current: { price: MIN, expiry: 0 }, lowestComparable: MIN - PRICE_TICK * 5n, lastRepriceTs: 0 }))
    expect(hold.kind).toBe('hold')
    expect(hold.price).toBe(MIN)
  })

  test('never lists below the minimum profitable price', () => {
    for (const comp of [U(0.1), U(0.3), MIN - 1n, MIN]) {
      const d = decideListing(input({ lowestComparable: comp }))
      expect(d.price).toBeGreaterThanOrEqual(MIN)
    }
  })

  test('raises the ask when the market improves, but only past the raise threshold', () => {
    const cur = U(0.479)
    const small = decideListing(input({ current: { price: cur, expiry: 0 }, lowestComparable: cur + PRICE_TICK * 2n, lastRepriceTs: 0 }))
    expect(small.kind).toBe('hold')
    const big = decideListing(input({ current: { price: cur, expiry: 0 }, lowestComparable: U(0.6), lastRepriceTs: 0 }))
    expect(big.kind).toBe('raise')
    expect(big.price).toBe(U(0.6) - PRICE_TICK)
  })

  test('an ask that fell well below the minimum profitable price is raised (after the cooldown)', () => {
    const d = decideListing(input({ current: { price: MIN - PRICE_TICK * 30n, expiry: 0 }, lowestComparable: U(0.7), lastRepriceTs: 0 }))
    expect(d.kind).toBe('raise')
    expect(d.price).toBeGreaterThanOrEqual(MIN)
    const cooling = decideListing(input({ current: { price: MIN - PRICE_TICK * 30n, expiry: 0 }, lowestComparable: U(0.7), lastRepriceTs: 99_990 }))
    expect(cooling.kind).toBe('hold')
  })

  test('does not chase its own gas: a shortfall smaller than another update costs is left alone', () => {
    const updateGas = 1_800n // 0.0018 USDC
    // The floor creeps up by roughly one update's gas each time the agent reprices. Raising to cover that
    // would burn more gas than it recovers, forever.
    const d = decideListing(input({ current: { price: MIN - 2n * PRICE_TICK, expiry: 0 }, lowestComparable: U(0.7), lastRepriceTs: 0, updateGas: updateGas * 2n }))
    expect(d.kind).toBe('hold')
    expect(d.reason).toContain('cost of another transaction')
  })
})

describe('rate limits and price-war protection', () => {
  const cur = { price: U(0.499), expiry: 0 }
  test('cooldown blocks a reprice', () => {
    const d = decideListing(input({ current: cur, lowestComparable: U(0.48), lastRepriceTs: 100_000 - 10 }))
    expect(d.kind).toBe('hold')
    expect(d.reason).toContain('cooldown')
  })
  test('cooldown grows exponentially when rivals keep undercutting', () => {
    // 4 reprices in 15 minutes -> cooldown 60 * 2^2 = 240s. 120s ago is still cooling.
    const d = decideListing(input({ current: cur, lowestComparable: U(0.48), lastRepriceTs: 100_000 - 120, repricesLast15m: 4 }))
    expect(d.kind).toBe('hold')
  })
  test('hourly limit blocks repricing', () => {
    const d = decideListing(input({ current: cur, lowestComparable: U(0.48), lastRepriceTs: 0, repricesLastHour: 10 }))
    expect(d.kind).toBe('hold')
    expect(d.reason).toContain('hourly')
  })
  test('tiny changes are ignored', () => {
    const d = decideListing(input({ current: { price: U(0.479), expiry: 0 }, lowestComparable: U(0.48), lastRepriceTs: 0 }))
    expect(d.kind).toBe('hold') // target equals current
  })
  test('expiring listings are renewed at the same price', () => {
    const d = decideListing(input({ current: { price: U(0.479), expiry: 100_000 + 120 }, lowestComparable: U(0.48), lastRepriceTs: 0 }))
    expect(d.kind).toBe('renew')
    expect(d.price).toBe(U(0.479))
  })
})

describe('exit decisions', () => {
  test('sells into an offer that meets or beats the ask', () => {
    const d = decideListing(input({ current: { price: U(0.499), expiry: 0 }, lowestComparable: U(0.5), bestOffer: { offerId: 7, price: U(0.5), collectionWide: true } }))
    expect(d.kind).toBe('accept')
    expect(d.offer?.offerId).toBe(7)
  })
  test('ignores offers below the minimum profitable price', () => {
    const d = decideListing(input({ current: { price: U(0.499), expiry: 0 }, lowestComparable: U(0.5), lastRepriceTs: 0, bestOffer: { offerId: 7, price: MIN - PRICE_TICK, collectionWide: true } }))
    expect(d.kind).not.toBe('accept')
  })
  test('exits into a profitable bid after an overlong hold', () => {
    const d = decideListing(input({
      current: { price: U(0.9), expiry: 0 }, lowestComparable: U(0.9), lastRepriceTs: 0, heldSec: pricing.expectedHoldingSec * 3,
      bestOffer: { offerId: 9, price: MIN + PRICE_TICK, collectionWide: false },
    }))
    expect(d.kind).toBe('accept')
  })
})

describe('comparable listings', () => {
  const l = (tokenId: string, seller: string, price: bigint): ListingRow => ({ collection: COLL, tokenId, seller, price, expiry: 0, listedTs: 1, updatedTs: 1 })
  const rarity = new Map<string, RarityInfo>([
    ['1', { score: 9, percentile: 0.01, tier: 0 }], ['2', { score: 5, percentile: 0.3, tier: 2 }], ['3', { score: 2, percentile: 0.9, tier: 3 }],
  ])
  const listings = [l('1', RIVAL, U(5)), l('2', RIVAL, U(1)), l('3', RIVAL2, U(0.5)), l('4', AGENT, U(0.1)), l('9', RIVAL, U(0.2))]

  test("ignores the agent's own listings and the token itself", () => {
    const res = comparableListings(listings, rarity, 2, { seller: AGENT, tokenId: '9' })
    expect(res.map((x) => x.tokenId)).not.toContain('4')
    expect(res.map((x) => x.tokenId)).not.toContain('9')
  })
  test('a more common token is not a comparable for a rarer one, but a rarer one is', () => {
    const forTier2 = comparableListings(listings, rarity, 2, { seller: AGENT }).map((x) => x.tokenId)
    expect(forTier2).toContain('1') // rarer: comparable
    expect(forTier2).toContain('2') // same tier
    expect(forTier2).not.toContain('3') // more common: not comparable
  })
})
