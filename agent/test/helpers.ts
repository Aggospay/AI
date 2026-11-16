import { openDb, type Db } from '../src/db'
import { setMarketFeeBps } from '../src/analysis/fees'
import { defaultSettings, parseSettings, serializeSettings, type EnvConfig, type Settings } from '../src/config'

export const FACTORY = '0x00000000000000000000000000000000000000f1' as const
export const MARKET = '0x00000000000000000000000000000000000000a1' as const
export const AGENT = '0x00000000000000000000000000000000000000b1'
export const RIVAL = '0x00000000000000000000000000000000000000c1'
export const RIVAL2 = '0x00000000000000000000000000000000000000c2'
export const BUYER = '0x00000000000000000000000000000000000000d1'
export const BUYER2 = '0x00000000000000000000000000000000000000d2'
export const BUYER3 = '0x00000000000000000000000000000000000000d3'
export const COLL = '0x00000000000000000000000000000000000000e1'

export const U = (usdc: number): bigint => BigInt(Math.round(usdc * 1_000_000))

export function testEnv(): EnvConfig {
  return {
    chainId: 5042002, dbPath: ':memory:', port: 0, adminToken: 'test-token', factory: FACTORY, market: MARKET,
    startBlock: 0n, wsUrl: undefined, rpcUrls: [],
  }
}

export function makeDb(): Db {
  const db = openDb(':memory:')
  setMarketFeeBps(db, 250)
  db.query("INSERT INTO wallets (address, label, role, circle_wallet_id) VALUES (?, 'agent', 'agent', 'w-agent')").run(AGENT)
  db.query("INSERT INTO wallets (address, label, role) VALUES (?, 'rival-1', 'fixture')").run(RIVAL)
  db.query("INSERT INTO wallets (address, label, role) VALUES (?, 'rival-2', 'fixture')").run(RIVAL2)
  return db
}

export function settingsWith(patch: unknown = {}): Settings {
  const base = serializeSettings(defaultSettings()) as Record<string, unknown>
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...a }
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? merge(a[k] as Record<string, unknown>, v as Record<string, unknown>) : v
    }
    return out
  }
  return parseSettings(merge(base, patch as Record<string, unknown>))
}

export function seedCollection(db: Db, address: string = COLL, over: Partial<Record<string, string | number>> = {}): void {
  const row = {
    creator: RIVAL, name: 'Test Apes', symbol: 'TAPE', mint_price: '1000000', max_supply: 1000, max_per_wallet: 10,
    mint_start: 1, mint_end: 2, royalty_bps: 500, seed_commitment: '0x' + '11'.repeat(32), created_block: 1, created_ts: 1,
    total_minted: 50, revealed: 0, verified: 1, ...over,
  }
  db.query(
    `INSERT OR REPLACE INTO collections (address, creator, name, symbol, mint_price, max_supply, max_per_wallet, mint_start, mint_end,
      royalty_bps, seed_commitment, created_block, created_ts, total_minted, revealed, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    address, row.creator, row.name, row.symbol, row.mint_price, row.max_supply, row.max_per_wallet, row.mint_start, row.mint_end,
    row.royalty_bps, row.seed_commitment, row.created_block, row.created_ts, row.total_minted, row.revealed, row.verified,
  )
}

let saleSeq = 0
export function seedSale(
  db: Db, tokenId: string, seller: string, buyer: string, price: bigint, ts: number, collection: string = COLL,
): number {
  saleSeq += 1
  const r = db
    .query(
      `INSERT INTO sales (collection, token_id, seller, buyer, price, fee, royalty, kind, ts, block, tx_hash, log_index)
       VALUES (?, ?, ?, ?, ?, '0', '0', 0, ?, ?, ?, 0)`,
    )
    .run(collection, tokenId, seller, buyer, price.toString(), ts, saleSeq, `0xsale${saleSeq}`)
  return Number(r.lastInsertRowid)
}

export function seedListing(
  db: Db, tokenId: string, seller: string, price: bigint, expiry = 0, collection: string = COLL, ts = 1000,
): void {
  db.query(
    `INSERT OR REPLACE INTO listings (collection, token_id, seller, price, expiry, status, listed_ts, updated_ts) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(collection, tokenId, seller, price.toString(), expiry, ts, ts)
}

export function seedToken(db: Db, tokenId: string, owner: string, traits: number | null = null, collection: string = COLL): void {
  db.query('INSERT OR REPLACE INTO tokens (collection, token_id, owner, minter, traits, updated_ts) VALUES (?, ?, ?, ?, ?, 1)').run(
    collection, tokenId, owner, owner, traits,
  )
}

// ---------------------------------------------------------------- context factory (paper mode, fake chain)
import { Bus } from '../src/bus'
import type { Client } from '../src/chain/clients'
import type { Indexer } from '../src/chain/indexer'
import { GasOracle } from '../src/exec/gas'
import { PaperExecutor } from '../src/exec/paper'
import { ExecutionService, type Executor } from '../src/exec/service'
import { OwnState } from '../src/state/own'
import type { Ctx } from '../src/strategies/ctx'

export interface TestCtx {
  ctx: Ctx
  paper: PaperExecutor
  setSettings: (patch: unknown) => void
  fakeIndexer: { lastSyncTs: number }
}

export async function makeCtx(db: Db, patch: unknown = {}, live: Executor | null = null): Promise<TestCtx> {
  let settings = settingsWith({ approvalMode: 'auto', ...(patch as Record<string, unknown>) })
  const getSettings = () => settings
  const fakeClient = { getGasPrice: () => Promise.resolve(160_000_000_000n) } as unknown as Client
  const gas = new GasOracle(db, fakeClient, 5042002)
  await gas.refresh(0)
  const own = new OwnState(db, fakeClient, getSettings)
  const paper = new PaperExecutor(db)
  const bus = new Bus()
  const exec = new ExecutionService(db, testEnv(), bus, getSettings, { paper, live: () => live }, gas)
  const fakeIndexer = { lastSyncTs: Date.now() }
  const indexer = { getStatus: () => ({ lastSyncTs: fakeIndexer.lastSyncTs, lagBlocks: 0 }) } as unknown as Indexer
  const ctx: Ctx = { db, client: fakeClient, env: testEnv(), bus, getSettings, own, gas, exec, indexer }
  return {
    ctx, paper, fakeIndexer,
    setSettings: (p) => {
      settings = settingsWith({ approvalMode: 'auto', ...(p as Record<string, unknown>) })
    },
  }
}

/** Wait until no intent is mid-flight. */
export async function settleIntents(db: Db, maxMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const n = db.query("SELECT COUNT(*) AS n FROM intents WHERE status IN ('approved','pending','submitted')").get() as { n: number }
    if (n.n === 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
}
