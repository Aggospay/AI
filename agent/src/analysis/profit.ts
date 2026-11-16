/**
 * Profit engine. Pure, bigint-only, no I/O. Mirrors NftMarket settlement rounding exactly:
 *   fee      = floor(price * feeBps / 10000)
 *   royalty  = min(floor(price * royaltyBps / 10000), floor(price * 1000 / 10000), price - fee)
 *   proceeds = price - fee - royalty
 * Net Profit = Expected Sale Proceeds - Acquisition Cost - Gas - Other Costs
 * (marketplace fee and royalty are already deducted inside Expected Sale Proceeds).
 * Gross price differences are never used as a profitability measure.
 */
import { Amount, gasTokenDecimalsFor, gasTokenToUsdc, usdcToGasToken } from '../../../src/onchain-money'
import { BPS, PRICE_TICK } from '../config'
import { ceilDiv, ceilToTick, floorToTick, maxBig, minBig } from '../util'

const MAX_ROYALTY_BPS = 1000n

export interface FeeSchedule {
  marketFeeBps: bigint
  royaltyBps: bigint
}

export interface Settlement {
  fee: bigint
  royalty: bigint
  proceeds: bigint
}

export function settle(price: bigint, fees: FeeSchedule): Settlement {
  if (price <= 0n) return { fee: 0n, royalty: 0n, proceeds: 0n }
  const fee = (price * fees.marketFeeBps) / BPS
  let royalty = (price * fees.royaltyBps) / BPS
  royalty = minBig(royalty, (price * MAX_ROYALTY_BPS) / BPS)
  royalty = minBig(royalty, price - fee)
  return { fee, royalty, proceeds: price - fee - royalty }
}

/** Gas cost in 6-decimal USDC, rounded UP, converting once from the 18-decimal native view. */
export function gasCostUsdc(chainId: number, gasUnits: bigint, feePerGasWei: bigint): bigint {
  const native = Amount.fromRaw(gasUnits * feePerGasWei, gasTokenDecimalsFor(chainId))
  const usdc = gasTokenToUsdc(chainId, native, 'trunc')
  const back = usdcToGasToken(chainId, usdc)
  return back.raw < native.raw ? usdc.raw + 1n : usdc.raw
}

export interface Costs {
  /** Mint price, purchase price or bid. */
  acquisitionPrice: bigint
  /** Gas paid by the agent to acquire (mint / buy / accept). */
  gasAcquire: bigint
  /** Gas paid by the agent to approve and list, plus expected repricing gas. */
  gasSell: bigint
  /** Anything else (listing fee, offer gas amortisation, safety buffer). */
  other: bigint
}

export const totalCost = (c: Costs): bigint => c.acquisitionPrice + c.gasAcquire + c.gasSell + c.other

export interface ProfitInput {
  costs: Costs
  fees: FeeSchedule
  expectedResalePrice: bigint
  /** Haircut to account for execution risk (bps off the expected resale). */
  haircutBps?: bigint
  expectedHoldingSec: number
  minNetProfit: bigint
  minRoiBps: bigint
}

export interface ProfitResult {
  expectedResalePrice: bigint
  effectiveResalePrice: bigint
  marketFee: bigint
  royalty: bigint
  saleProceeds: bigint
  totalCost: bigint
  netProfit: bigint
  roiBps: bigint
  annualizedRoiBps: bigint
  holdingSec: number
  meetsMinProfit: boolean
  meetsMinRoi: boolean
  ok: boolean
  breakEvenPrice: bigint
  reasons: string[]
}

/** Smallest tick-aligned price whose settlement proceeds cover `required`. Exact w.r.t. contract rounding. */
export function priceForProceeds(required: bigint, fees: FeeSchedule): bigint {
  if (required <= 0n) return PRICE_TICK
  const keep = BPS - fees.marketFeeBps - minBig(fees.royaltyBps, MAX_ROYALTY_BPS)
  if (keep <= 0n) throw new Error('fees leave no proceeds')
  let price = ceilToTick(ceilDiv(required * BPS, keep), PRICE_TICK)
  // Floors in settle() can leave proceeds a unit short: step up until covered.
  for (let i = 0; i < 100 && settle(price, fees).proceeds < required; i++) price += PRICE_TICK
  return price
}

export function evaluateTrade(input: ProfitInput): ProfitResult {
  const haircut = input.haircutBps ?? 0n
  const effective = (input.expectedResalePrice * (BPS - haircut)) / BPS
  const priced = floorToTick(effective, PRICE_TICK)
  const s = settle(priced, input.fees)
  const cost = totalCost(input.costs)
  const net = s.proceeds - cost
  const basis = cost > 0n ? cost : 1n
  const roiBps = (net * BPS) / basis
  const yearSec = 31_536_000n
  const hold = BigInt(Math.max(1, input.expectedHoldingSec))
  const annualized = (roiBps * yearSec) / hold
  const meetsMinProfit = net >= input.minNetProfit
  const meetsMinRoi = roiBps >= input.minRoiBps
  const reasons: string[] = []
  if (net <= 0n) reasons.push('expected net profit is not positive')
  if (!meetsMinProfit) reasons.push('net profit below configured minimum')
  if (!meetsMinRoi) reasons.push('ROI below configured minimum')
  return {
    expectedResalePrice: input.expectedResalePrice,
    effectiveResalePrice: priced,
    marketFee: s.fee,
    royalty: s.royalty,
    saleProceeds: s.proceeds,
    totalCost: cost,
    netProfit: net,
    roiBps,
    annualizedRoiBps: annualized,
    holdingSec: Number(hold),
    meetsMinProfit,
    meetsMinRoi,
    ok: net > 0n && meetsMinProfit && meetsMinRoi,
    breakEvenPrice: priceForProceeds(cost, input.fees),
    reasons,
  }
}

/**
 * Lowest price at which selling still yields at least `minNetProfit` AND `minRoiBps`
 * on top of everything already spent (`sunkCost` = acquisition + gas paid + gas still to pay + other).
 */
export function minProfitablePrice(
  sunkCost: bigint,
  fees: FeeSchedule,
  minNetProfit: bigint,
  minRoiBps: bigint,
): bigint {
  const profitFromRoi = (sunkCost * minRoiBps) / BPS
  const requiredProfit = maxBig(minNetProfit, profitFromRoi)
  return priceForProceeds(sunkCost + requiredProfit, fees)
}

/**
 * Highest tick-aligned acquisition price (mint price, purchase or bid) that still meets
 * the profit and ROI floors given an expected resale price and fixed gas / other costs.
 * Returns 0n when no positive price qualifies.
 */
export function maxAcquisitionPrice(args: {
  expectedResalePrice: bigint
  fees: FeeSchedule
  gasTotal: bigint
  other: bigint
  minNetProfit: bigint
  minRoiBps: bigint
  haircutBps?: bigint
  ceiling?: bigint
}): bigint {
  const effective = floorToTick(
    (args.expectedResalePrice * (BPS - (args.haircutBps ?? 0n))) / BPS,
    PRICE_TICK,
  )
  const { proceeds } = settle(effective, args.fees)
  const spendable = proceeds - args.gasTotal - args.other
  if (spendable <= 0n) return 0n
  const byProfit = spendable - args.minNetProfit
  // net / (A + gas + other) >= roi  =>  A <= proceeds / (1 + roi) - gas - other
  const byRoi = (proceeds * BPS) / (BPS + args.minRoiBps) - args.gasTotal - args.other
  let best = floorToTick(minBig(byProfit, byRoi), PRICE_TICK)
  if (args.ceiling !== undefined) best = minBig(best, floorToTick(args.ceiling, PRICE_TICK))
  return best > 0n ? best : 0n
}
