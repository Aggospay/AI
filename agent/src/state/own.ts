/**
 * The agent's own state, mode-aware. Positions are the source of truth for holdings in both modes.
 * Listings and offers come from the indexed chain state in live mode and from simulated orders in
 * paper mode. Capital is the onchain USDC balance (live) or a virtual balance built from the paper ledger.
 */
import { erc20Abi } from '../abis'
import { agentAddress } from '../analysis/market'
import type { Client } from '../chain/clients'
import { USDC_ADDRESS } from '../chain/clients'
import type { Settings } from '../config'
import { kvGet, type Db } from '../db'
import { lc, nowSec } from '../util'

export interface Holding {
  positionId: number
  collection: string
  tokenId: string
  source: string
  acquiredPrice: bigint
  acquiredCost: bigint
  acquiredTs: number
  paper: boolean
}

export interface OwnListing {
  collection: string
  tokenId: string
  price: bigint
  expiry: number
  listedTs: number
  updatedTs: number
}

export interface OwnOffer {
  offerId: number
  collection: string
  tokenId: string
  collectionWide: boolean
  price: bigint
  expiry: number
  createdTs: number
  updatedTs: number
}

export interface Capital {
  balance: bigint
  committedToOffers: bigint
  available: bigint
}

interface Raw { [k: string]: unknown }

export class OwnState {
  private balCache: { at: number; value: bigint } | null = null

  constructor(
    private db: Db,
    private client: Client,
    private getSettings: () => Settings,
  ) {}

  paper(): boolean {
    return this.getSettings().mode === 'paper'
  }

  holdings(): Holding[] {
    const rows = this.db
      .query("SELECT * FROM positions WHERE status = 'open' AND paper = ? ORDER BY acquired_ts ASC")
      .all(this.paper() ? 1 : 0) as Raw[]
    return rows.map((r) => ({
      positionId: Number(r.id), collection: String(r.collection), tokenId: String(r.token_id), source: String(r.source),
      acquiredPrice: BigInt(String(r.acquired_price)), acquiredCost: BigInt(String(r.acquired_cost)),
      acquiredTs: Number(r.acquired_ts), paper: Number(r.paper) === 1,
    }))
  }

  listings(): OwnListing[] {
    const now = nowSec()
    if (this.paper()) {
      return (this.db.query("SELECT * FROM paper_orders WHERE kind = 'listing' AND status = 'active'").all() as Raw[])
        .map((r) => ({
          collection: String(r.collection), tokenId: String(r.token_id), price: BigInt(String(r.price)),
          expiry: Number(r.expiry), listedTs: Number(r.created_ts), updatedTs: Number(r.updated_ts),
        }))
        .filter((l) => l.expiry === 0 || l.expiry > now)
    }
    const agent = agentAddress(this.db)
    if (!agent) return []
    return (this.db.query("SELECT * FROM listings WHERE status = 'active' AND seller = ?").all(agent) as Raw[])
      .map((r) => ({
        collection: String(r.collection), tokenId: String(r.token_id), price: BigInt(String(r.price)),
        expiry: Number(r.expiry), listedTs: Number(r.listed_ts), updatedTs: Number(r.updated_ts),
      }))
      .filter((l) => l.expiry === 0 || l.expiry > now)
  }

  listingOf(collection: string, tokenId: string): OwnListing | null {
    return this.listings().find((l) => lc(l.collection) === lc(collection) && l.tokenId === tokenId) ?? null
  }

  offers(): OwnOffer[] {
    const now = nowSec()
    if (this.paper()) {
      return (this.db.query("SELECT * FROM paper_orders WHERE kind = 'offer' AND status = 'active'").all() as Raw[])
        .map((r) => ({
          offerId: Number(r.id), collection: String(r.collection), tokenId: String(r.token_id),
          collectionWide: Number(r.collection_wide) === 1, price: BigInt(String(r.price)), expiry: Number(r.expiry),
          createdTs: Number(r.created_ts), updatedTs: Number(r.updated_ts),
        }))
        .filter((o) => o.expiry > now)
    }
    const agent = agentAddress(this.db)
    if (!agent) return []
    return (this.db.query("SELECT * FROM offers WHERE status = 'active' AND bidder = ?").all(agent) as Raw[])
      .map((r) => ({
        offerId: Number(r.offer_id), collection: String(r.collection), tokenId: String(r.token_id),
        collectionWide: Number(r.collection_wide) === 1, price: BigInt(String(r.price)), expiry: Number(r.expiry),
        createdTs: Number(r.created_ts), updatedTs: Number(r.updated_ts),
      }))
      .filter((o) => o.expiry > now)
  }

  committedToOffers(): bigint {
    return this.offers().reduce((s, o) => s + o.price, 0n)
  }

  paperBalance(): bigint {
    const start = BigInt(kvGet<string>(this.db, 'paper.startBalance', process.env.AGENT_PAPER_BALANCE ?? '100000000'))
    const row = this.db.query('SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS s FROM ledger WHERE paper = 1').get() as {
      s: number
    }
    // CAST AS INTEGER is exact for the magnitudes involved (USDC micro-units well below 2^63).
    return start + BigInt(row.s)
  }

  async liveBalance(): Promise<bigint> {
    const agent = agentAddress(this.db)
    if (!agent) return 0n
    if (this.balCache && Date.now() - this.balCache.at < 4000) return this.balCache.value
    const value = await this.client.readContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [agent as `0x${string}`],
    })
    this.balCache = { at: Date.now(), value }
    return value
  }

  invalidateBalance(): void {
    this.balCache = null
  }

  async capital(): Promise<Capital> {
    const committed = this.committedToOffers()
    const raw = this.paper() ? this.paperBalance() : await this.liveBalance()
    // Live: escrowed offer funds have already left the wallet. Paper: ledger does not debit escrow, so subtract.
    const balance = raw
    const available = this.paper() ? (raw > committed ? raw - committed : 0n) : raw
    return { balance, committedToOffers: committed, available }
  }

  /** Total capital base for allocation limits: free balance plus value locked in positions and offers. */
  async totalCapital(): Promise<bigint> {
    const cap = await this.capital()
    const invested = this.holdings().reduce((s, h) => s + h.acquiredCost, 0n)
    return cap.available + cap.committedToOffers + invested
  }
}
