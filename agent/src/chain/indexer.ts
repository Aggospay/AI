/**
 * Event indexer: head-triggered (WebSocket when configured, short polling otherwise),
 * cursor-persisted backfill, adaptive log range, idempotent reduction.
 * Never starts from block 0: it resumes from its cursor, else AGENT_START_BLOCK (the factory
 * deployment block), else a bounded lookback from the current head.
 */
import { decodeEventLog, type Log } from 'viem'
import { indexedAbi, collectionAbi } from '../abis'
import { type Bus } from '../bus'
import type { EnvConfig } from '../config'
import type { Db } from '../db'
import { logger } from '../log'
import { errMessage, nowMs, sleep } from '../util'
import { subscribeHeads, type Client, type HeadSubscription } from './clients'
import { applyLog, type DecodedLog } from './reducer'

const log = logger('indexer')
const CURSOR_KEY = 'main'
const DEFAULT_LOOKBACK = 5000n

export interface IndexerStatus {
  cursor: number | null
  head: number | null
  lagBlocks: number | null
  lastSyncTs: number | null
  lastError: string | null
  wsConnected: boolean
  eventsIndexed: number
  chunk: number
}

export function knownAddresses(db: Db, env: EnvConfig): `0x${string}`[] {
  const out = new Set<string>()
  if (env.factory) out.add(env.factory.toLowerCase())
  if (env.market) out.add(env.market.toLowerCase())
  for (const row of db.query('SELECT address FROM collections').all() as Array<{ address: string }>) {
    out.add(row.address)
  }
  return [...out] as `0x${string}`[]
}

export class Indexer {
  private running = false
  private wake: (() => void) | null = null
  private sub: HeadSubscription | null = null
  private chunk = 2000
  private blockTs = new Map<bigint, number>()
  private status: IndexerStatus = {
    cursor: null, head: null, lagBlocks: null, lastSyncTs: null, lastError: null,
    wsConnected: false, eventsIndexed: 0, chunk: 2000,
  }

  constructor(
    private db: Db,
    private client: Client,
    private env: EnvConfig,
    private bus: Bus,
  ) {}

  getStatus(): IndexerStatus {
    return { ...this.status, wsConnected: this.sub?.connected() ?? false, chunk: this.chunk }
  }

  kick(): void {
    this.wake?.()
  }

  private getCursor(): bigint | null {
    const row = this.db.query('SELECT block FROM cursor WHERE key = ?').get(CURSOR_KEY) as { block: number } | null
    return row ? BigInt(row.block) : null
  }

  private setCursor(block: bigint): void {
    this.db
      .query('INSERT INTO cursor (key, block) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET block = excluded.block')
      .run(CURSOR_KEY, Number(block))
  }

  private async timestampFor(blockNumber: bigint): Promise<number> {
    const cached = this.blockTs.get(blockNumber)
    if (cached !== undefined) return cached
    const block = await this.client.getBlock({ blockNumber })
    const ts = Number(block.timestamp)
    this.blockTs.set(blockNumber, ts)
    if (this.blockTs.size > 2000) {
      const first = this.blockTs.keys().next().value
      if (first !== undefined) this.blockTs.delete(first)
    }
    return ts
  }

  private async fetchRange(addresses: `0x${string}`[], from: bigint, to: bigint): Promise<DecodedLog[]> {
    if (addresses.length === 0) return []
    const raw = (await this.client.getLogs({ address: addresses, fromBlock: from, toBlock: to })) as Log[]
    const uniqueBlocks = [...new Set(raw.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))]
    for (let i = 0; i < uniqueBlocks.length; i += 10) {
      await Promise.all(uniqueBlocks.slice(i, i + 10).map((b) => this.timestampFor(b)))
    }
    const out: DecodedLog[] = []
    for (const l of raw) {
      if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null) continue
      try {
        const decoded = decodeEventLog({ abi: indexedAbi, data: l.data, topics: l.topics as [`0x${string}`] })
        out.push({
          block: Number(l.blockNumber),
          logIndex: l.logIndex,
          txHash: l.transactionHash,
          address: l.address,
          name: decoded.eventName,
          args: (decoded.args ?? {}),
          ts: this.blockTs.get(l.blockNumber) ?? 0,
        })
      } catch {
        // Events outside our ABI (for example Approval) are irrelevant to the projections.
      }
    }
    out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
    return out
  }

  /** Processes one range. Returns the number of new events applied. */
  async syncOnce(): Promise<{ from: bigint; to: bigint; applied: number } | null> {
    const head = await this.client.getBlockNumber()
    this.status.head = Number(head)
    let cursor = this.getCursor()
    if (cursor === null) {
      if (this.env.startBlock !== undefined) cursor = this.env.startBlock - 1n
      else {
        cursor = head > DEFAULT_LOOKBACK ? head - DEFAULT_LOOKBACK : 0n
        log.warn('AGENT_START_BLOCK not set: starting from a bounded lookback, older events are not indexed', {
          start: cursor.toString(),
        })
      }
      this.setCursor(cursor)
    }
    this.status.cursor = Number(cursor)
    this.status.lagBlocks = Number(head - cursor)
    if (cursor >= head) {
      this.status.lastSyncTs = nowMs()
      return null
    }
    const from = cursor + 1n
    const to = head - from + 1n > BigInt(this.chunk) ? from + BigInt(this.chunk) - 1n : head

    let logs: DecodedLog[]
    try {
      logs = await this.fetchRange(knownAddresses(this.db, this.env), from, to)
    } catch (e) {
      if (this.chunk > 50) {
        this.chunk = Math.max(50, Math.floor(this.chunk / 2))
        log.warn('getLogs failed, shrinking range', { chunk: this.chunk, error: errMessage(e) })
      }
      throw e
    }

    const factory = this.env.factory
    const touched = new Map<string, Set<string>>()
    const newCollections: string[] = []
    let applied = 0
    const apply = (batch: DecodedLog[]) => {
      this.db.exec('BEGIN')
      try {
        for (const l of batch) {
          const r = applyLog(this.db, l, factory)
          if (r.applied) applied += 1
          if (r.newCollection) newCollections.push(r.newCollection)
          for (const t of r.touched) {
            const set = touched.get(t.collection) ?? new Set<string>()
            if (t.tokenId !== undefined) set.add(t.tokenId)
            touched.set(t.collection, set)
          }
        }
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    }
    apply(logs)

    // Collections discovered in this range: fetch their own logs for the same range.
    if (newCollections.length > 0) {
      const extra = await this.fetchRange(newCollections as `0x${string}`[], from, to)
      apply(extra)
    }
    this.setCursor(to)
    this.status.cursor = Number(to)
    this.status.lagBlocks = Number(head - to)
    this.status.lastSyncTs = nowMs()
    this.status.lastError = null
    this.status.eventsIndexed += applied
    if (this.chunk < 2000) this.chunk = Math.min(2000, this.chunk * 2)
    if (applied > 0) {
      this.bus.emit('market:changed', {
        collections: [...touched.entries()].map(([collection, tokens]) => ({ collection, tokens: [...tokens] })),
        applied,
      })
    }
    return { from, to, applied }
  }

  /** Main loop. Resolves when stop() is called. */
  async run(): Promise<void> {
    this.running = true
    this.sub = subscribeHeads(this.env, (n) => {
      this.bus.emit('head', n)
      this.kick()
    })
    let backoff = 500
    while (this.running) {
      try {
        let more = true
        while (more && this.running) {
          const r = await this.syncOnce()
          more = r !== null && (this.status.lagBlocks ?? 0) > 0
        }
        backoff = 500
        await this.idle(this.sub.connected() ? 5000 : 1000)
      } catch (e) {
        this.status.lastError = errMessage(e)
        log.warn('sync failed, retrying', { error: this.status.lastError, backoffMs: backoff })
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(t)
        this.wake = null
        resolve()
      }
    })
  }

  stop(): void {
    this.running = false
    this.sub?.stop()
    this.wake?.()
  }
}

/** Reads revealed traits for tokens that do not have them yet (after a Revealed event). */
export async function refreshTraits(db: Db, client: Client, limit = 200): Promise<number> {
  const rows = db
    .query(
      `SELECT t.collection AS collection, t.token_id AS token_id FROM tokens t
       JOIN collections c ON c.address = t.collection
       WHERE c.revealed = 1 AND t.traits IS NULL LIMIT ?`,
    )
    .all(limit) as Array<{ collection: string; token_id: string }>
  let updated = 0
  for (const row of rows) {
    try {
      const traits = await client.readContract({
        address: row.collection as `0x${string}`,
        abi: collectionAbi,
        functionName: 'traitsOf',
        args: [BigInt(row.token_id)],
      })
      db.query('UPDATE tokens SET traits = ? WHERE collection = ? AND token_id = ?').run(
        Number(traits), row.collection, row.token_id,
      )
      updated += 1
    } catch (e) {
      log.debug('traitsOf failed', { collection: row.collection, token: row.token_id, error: errMessage(e) })
    }
  }
  return updated
}
