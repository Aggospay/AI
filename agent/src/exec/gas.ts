/**
 * Gas estimation in USDC. Arc's gas token IS USDC: price comes back in the 18-decimal native
 * view and is converted exactly once, rounding up, by gasCostUsdc. Unit counts start from
 * conservative defaults and track observed receipts (exponential moving average).
 */
import { gasCostUsdc } from '../analysis/profit'
import { kvGet, kvSet, type Db } from '../db'
import type { Client } from '../chain/clients'
import type { ActionKind } from '../types'

const DEFAULT_UNITS: Record<ActionKind, number> = {
  mint: 190_000,
  buy: 280_000,
  list: 110_000,
  updateListing: 70_000,
  cancelListing: 50_000,
  makeOffer: 170_000,
  updateOffer: 90_000,
  cancelOffer: 70_000,
  acceptOffer: 300_000,
  approveCollection: 60_000,
  approveUsdc: 60_000,
}

export class GasOracle {
  private priceWei: bigint | null = null
  private fetchedAt = 0

  constructor(
    private db: Db,
    private client: Client,
    private chainId: number,
  ) {}

  async refresh(maxAgeMs = 10_000): Promise<bigint> {
    if (this.priceWei !== null && Date.now() - this.fetchedAt < maxAgeMs) return this.priceWei
    const price = await this.client.getGasPrice()
    this.priceWei = price
    this.fetchedAt = Date.now()
    kvSet(this.db, 'gas.priceWei', price.toString())
    return price
  }

  /** Current gas price in wei if known (never fabricated). */
  knownPrice(): bigint | null {
    return this.priceWei
  }

  units(kind: ActionKind): bigint {
    const observed = kvGet<Record<string, number>>(this.db, 'gas.units', {})
    return BigInt(Math.round(observed[kind] ?? DEFAULT_UNITS[kind]))
  }

  /** Cost in USDC base units, rounded up. Throws if no gas price has ever been read. */
  costUsdc(kind: ActionKind, repeat = 1): bigint {
    if (this.priceWei === null) throw new Error('gas price unavailable')
    // 20% headroom on the live price: Circle's MEDIUM fee level may sit above getGasPrice.
    const padded = (this.priceWei * 120n) / 100n
    return gasCostUsdc(this.chainId, this.units(kind) * BigInt(repeat), padded)
  }

  /** Fold an observed receipt into the moving average. */
  recordActual(kind: ActionKind, gasUsed: bigint): void {
    const observed = kvGet<Record<string, number>>(this.db, 'gas.units', {})
    const prev = observed[kind] ?? DEFAULT_UNITS[kind]
    observed[kind] = Math.round(prev * 0.7 + Number(gasUsed) * 1.3 * 0.3) // 30% weight, +30% margin on the sample
    kvSet(this.db, 'gas.units', observed)
  }
}
