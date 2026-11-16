import { describe, expect, test } from 'bun:test'
import {
  evaluateTrade, maxAcquisitionPrice, minProfitablePrice, priceForProceeds, settle, gasCostUsdc,
} from '../src/analysis/profit'
import { PRICE_TICK } from '../src/config'
import { U } from './helpers'

const fees = { marketFeeBps: 250n, royaltyBps: 500n } // 2.5% + 5%

describe('settle (mirrors NftMarket rounding)', () => {
  test('splits price into fee, royalty and proceeds that sum exactly', () => {
    for (const price of [1000n, 1001n, 999_999n, 1_234_567n, 100_000_000n]) {
      const s = settle(price, fees)
      expect(s.fee + s.royalty + s.proceeds).toBe(price)
      expect(s.fee).toBe((price * 250n) / 10_000n)
    }
  })
  test('royalty is capped at 10% and never exceeds price minus fee', () => {
    const s = settle(10_000n, { marketFeeBps: 1000n, royaltyBps: 5000n })
    expect(s.royalty).toBe(1000n)
    expect(s.fee + s.royalty).toBeLessThanOrEqual(10_000n)
  })
})

describe('evaluateTrade', () => {
  const base = {
    costs: { acquisitionPrice: U(10), gasAcquire: U(0.02), gasSell: U(0.05), other: 0n },
    fees, expectedHoldingSec: 86_400, minNetProfit: U(0.5), minRoiBps: 500n,
  }
  test('net profit = proceeds minus all costs, never gross difference', () => {
    const r = evaluateTrade({ ...base, expectedResalePrice: U(12) })
    const proceeds = settle(U(12), fees).proceeds
    expect(r.saleProceeds).toBe(proceeds)
    expect(r.netProfit).toBe(proceeds - (U(10) + U(0.02) + U(0.05)))
    // Gross difference is 2.000 but net is smaller: fees and royalty eat most of it.
    expect(r.netProfit).toBeLessThan(U(2))
  })
  test('an NFT bought below floor can still be unprofitable to sell', () => {
    // Bought at 9.5 vs a 10.0 floor: a 0.5 gross edge, but 7.5% in fees and royalties exceeds it.
    const r = evaluateTrade({ ...base, costs: { ...base.costs, acquisitionPrice: U(9.5) }, expectedResalePrice: U(10) })
    expect(r.netProfit).toBeLessThan(0n)
    expect(r.ok).toBe(false)
    expect(r.reasons.length).toBeGreaterThan(0)
  })
  test('haircut reduces effective resale', () => {
    const a = evaluateTrade({ ...base, expectedResalePrice: U(14) })
    const b = evaluateTrade({ ...base, expectedResalePrice: U(14), haircutBps: 1000n })
    expect(b.netProfit).toBeLessThan(a.netProfit)
  })
  test('ok requires minimum profit AND minimum ROI', () => {
    const r = evaluateTrade({ ...base, expectedResalePrice: U(11.5), minNetProfit: 0n, minRoiBps: 5000n })
    expect(r.netProfit).toBeGreaterThan(0n)
    expect(r.meetsMinRoi).toBe(false)
    expect(r.ok).toBe(false)
  })
})

describe('minProfitablePrice', () => {
  test('is tick aligned, meets the profit floor, and one tick lower does not', () => {
    const sunk = U(10.07)
    const p = minProfitablePrice(sunk, fees, U(0.5), 0n)
    expect(p % PRICE_TICK).toBe(0n)
    expect(settle(p, fees).proceeds - sunk).toBeGreaterThanOrEqual(U(0.5))
    expect(settle(p - PRICE_TICK, fees).proceeds - sunk).toBeLessThan(U(0.5))
  })
  test('ROI floor can dominate the absolute floor', () => {
    const sunk = U(100)
    const p = minProfitablePrice(sunk, fees, U(0.1), 1000n) // 10% ROI
    expect(settle(p, fees).proceeds - sunk).toBeGreaterThanOrEqual(U(10))
  })
  test('priceForProceeds is exact for odd amounts', () => {
    for (const required of [1n, 1234n, 987_654n, 55_555_555n]) {
      const p = priceForProceeds(required, fees)
      expect(settle(p, fees).proceeds).toBeGreaterThanOrEqual(required)
      expect(p % PRICE_TICK).toBe(0n)
    }
  })
})

describe('maxAcquisitionPrice', () => {
  const args = { fees, gasTotal: U(0.1), other: 0n, minNetProfit: U(0.5), minRoiBps: 500n }
  test('buying at the maximum meets the floors; one tick more breaks one of them', () => {
    const max = maxAcquisitionPrice({ ...args, expectedResalePrice: U(20) })
    expect(max).toBeGreaterThan(0n)
    const at = (price: bigint) =>
      evaluateTrade({
        costs: { acquisitionPrice: price, gasAcquire: U(0.1), gasSell: 0n, other: 0n }, fees,
        expectedResalePrice: U(20), expectedHoldingSec: 1, minNetProfit: U(0.5), minRoiBps: 500n,
      })
    expect(at(max).ok).toBe(true)
    expect(at(max + PRICE_TICK * 2n).ok).toBe(false)
  })
  test('returns 0 when resale cannot cover gas', () => {
    expect(maxAcquisitionPrice({ ...args, expectedResalePrice: 50_000n, gasTotal: U(1) })).toBe(0n)
  })
  test('respects a ceiling', () => {
    const max = maxAcquisitionPrice({ ...args, expectedResalePrice: U(200), ceiling: U(5) })
    expect(max).toBeLessThanOrEqual(U(5))
  })
})

describe('gasCostUsdc', () => {
  test('converts 18-decimal gas math to 6-decimal USDC rounding up', () => {
    // 150_000 gas at 160 gwei = 0.024 USDC exactly = 24_000 micro-USDC
    expect(gasCostUsdc(5042002, 150_000n, 160_000_000_000n)).toBe(24_000n)
    // A remainder always rounds up, never down.
    expect(gasCostUsdc(5042002, 1n, 1n)).toBe(1n)
  })
})
