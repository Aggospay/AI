/** Shared dependencies and helpers for strategy modules. */
import { agentAddress, getCollection, walletRoles, type CollectionRow, type CollectionStats } from '../analysis/market'
import type { CollectionScore } from '../analysis/scoring'
import type { Bus } from '../bus'
import type { Indexer } from '../chain/indexer'
import type { Client } from '../chain/clients'
import type { EnvConfig, Settings } from '../config'
import type { Db } from '../db'
import { collectionExposure, spendTotals, type RiskInput } from '../risk/engine'
import type { ExecutionService } from '../exec/service'
import type { GasOracle } from '../exec/gas'
import type { OwnState } from '../state/own'
import type { Action } from '../types'
import { nowSec } from '../util'

export interface Ctx {
  db: Db
  client: Client
  env: EnvConfig
  bus: Bus
  getSettings: () => Settings
  own: OwnState
  gas: GasOracle
  exec: ExecutionService
  indexer: Indexer
}

/** Collections strategies may act on: verified, optionally narrowed by the watch list. */
export function eligibleCollections(ctx: Ctx): CollectionRow[] {
  const s = ctx.getSettings()
  const rows = ctx.db.query('SELECT address FROM collections WHERE verified = 1').all() as Array<{ address: string }>
  const watch = s.watch.collections.map((a) => a.toLowerCase())
  return rows
    .filter((r) => watch.length === 0 || watch.includes(r.address))
    .map((r) => getCollection(ctx.db, r.address))
    .filter((c): c is CollectionRow => c !== null)
}

/** Seconds timestamp of the last successful indexer sync: the freshness of every price we read. */
export function indexerFreshTs(ctx: Ctx): number {
  const st = ctx.indexer.getStatus()
  return st.lastSyncTs ? Math.floor(st.lastSyncTs / 1000) : 0
}

export async function buildRisk(
  ctx: Ctx,
  action: Action,
  extra: {
    collection?: CollectionRow | null
    stats?: CollectionStats | null
    score?: CollectionScore | null
    analysis?: RiskInput['analysis']
    gasCost?: bigint
    fairValue?: bigint | null
    fairValueConfidence?: number
    unitPrice?: bigint
    counterparty?: string
    minListPrice?: bigint
    listPrice?: bigint
    priceObservedAt?: number
  } = {},
): Promise<RiskInput> {
  const now = nowSec()
  const exposure = action.collection
    ? collectionExposure(ctx.db, action.collection, agentAddress(ctx.db), now)
    : { committed: 0n, tokens: 0, openOfferCapital: 0n }
  const allOffers = ctx.own.committedToOffers()
  return {
    settings: ctx.getSettings(),
    now,
    action,
    collection: extra.collection ?? (action.collection ? getCollection(ctx.db, action.collection) : null),
    stats: extra.stats ?? null,
    score: extra.score ?? null,
    analysis: extra.analysis ?? null,
    gasCost: extra.gasCost,
    fairValue: extra.fairValue,
    fairValueConfidence: extra.fairValueConfidence,
    unitPrice: extra.unitPrice,
    counterparty: extra.counterparty,
    roles: walletRoles(ctx.db),
    agent: agentAddress(ctx.db),
    exposure: {
      collectionCommitted: exposure.committed,
      collectionTokens: exposure.tokens,
      totalCapital: await ctx.own.totalCapital(),
      openOfferCapital: allOffers,
    },
    spent: spendTotals(ctx.db, now),
    minListPrice: extra.minListPrice,
    listPrice: extra.listPrice,
    priceObservedAt: extra.priceObservedAt ?? indexerFreshTs(ctx),
  }
}
