import { describe, expect, test } from 'bun:test'
import { defaultSettings, PRICE_TICK } from '../src/config'
import { decideOffer, type OfferDecideInput } from '../src/strategies/offers'
import { U } from './helpers'

const offers = { ...defaultSettings().offers, cooldownSec: 30, renewBeforeSec: 300 }

function input(over: Partial<OfferDecideInput>): OfferDecideInput {
  return { now: 10_000, maxBid: U(1), rivalBest: null, openingBid: U(0.8), own: null, lastActionTs: null, offers, ...over }
}

describe('offer manager', () => {
  test('opens below fair value when nobody else is bidding', () => {
    const d = decideOffer(input({}))
    expect(d.kind).toBe('make')
    expect(d.price).toBe(U(0.8))
  })
  test('counters a rival by the smallest increment', () => {
    const d = decideOffer(input({ rivalBest: U(0.7) }))
    expect(d.kind).toBe('make')
    expect(d.price).toBe(U(0.7) + PRICE_TICK)
  })
  test('raises its own bid when outbid, one increment above the rival', () => {
    const d = decideOffer(input({ own: { offerId: 1, price: U(0.7), expiry: 99_999 }, rivalBest: U(0.75), lastActionTs: 0 }))
    expect(d.kind).toBe('raise')
    expect(d.price).toBe(U(0.75) + PRICE_TICK)
  })
  test('does not drift up to the ceiling when nobody is bidding against it', () => {
    const d = decideOffer(input({ own: { offerId: 1, price: U(0.8), expiry: 99_999 }, rivalBest: null, maxBid: U(1), lastActionTs: 0 }))
    expect(d.kind).toBe('hold')
  })
  test('never exceeds the maximum profitable bid', () => {
    const d = decideOffer(input({ rivalBest: U(0.999) }))
    expect(d.kind).toBe('make')
    expect(d.price).toBeLessThanOrEqual(U(1))
  })
  test('cancels when the rival is above the maximum, freeing capital', () => {
    const d = decideOffer(input({ own: { offerId: 1, price: U(0.9), expiry: 99_999 }, rivalBest: U(1.2) }))
    expect(d.kind).toBe('cancel')
    const none = decideOffer(input({ rivalBest: U(1.2) }))
    expect(none.kind).toBe('hold')
  })
  test('reduces an excessive bid when competition decreases', () => {
    const d = decideOffer(input({ own: { offerId: 1, price: U(0.95), expiry: 99_999 }, rivalBest: U(0.6), lastActionTs: 0 }))
    expect(d.kind).toBe('lower')
    expect(d.price).toBe(U(0.6) + PRICE_TICK)
  })
  test('does not bid against itself: holds when already the best bid', () => {
    const d = decideOffer(input({ own: { offerId: 1, price: U(0.7) + PRICE_TICK, expiry: 99_999 }, rivalBest: U(0.7), lastActionTs: 0 }))
    expect(d.kind).toBe('hold')
  })
  test('cooldown prevents rapid re-bidding', () => {
    const d = decideOffer(input({ own: { offerId: 1, price: U(0.7), expiry: 99_999 }, rivalBest: U(0.75), lastActionTs: 10_000 - 5 }))
    expect(d.kind).toBe('hold')
  })
  test('lowers immediately if own bid exceeds a reduced ceiling', () => {
    const d = decideOffer(input({ maxBid: U(0.6), own: { offerId: 1, price: U(0.9), expiry: 99_999 }, lastActionTs: 10_000 - 1 }))
    expect(d.kind).toBe('lower')
    expect(d.price).toBeLessThanOrEqual(U(0.6))
  })
  test('renews before expiry at the same price', () => {
    const d = decideOffer(input({ own: { offerId: 1, price: U(0.8), expiry: 10_000 + 100 }, openingBid: U(0.8), lastActionTs: 0 }))
    expect(d.kind).toBe('renew')
    expect(d.price).toBe(U(0.8))
  })
  test('cancels when no price is profitable any more', () => {
    const d = decideOffer(input({ maxBid: 0n, own: { offerId: 1, price: U(0.5), expiry: 99_999 } }))
    expect(d.kind).toBe('cancel')
  })
})
