/** Fee schedule lookup. The market fee comes from the chain (cached in kv), royalty from the collection. */
import { kvGet, kvSet, type Db } from '../db'
import type { FeeSchedule } from './profit'
import { getCollection } from './market'

export function setMarketFeeBps(db: Db, bps: number): void {
  kvSet(db, 'market.feeBps', bps)
}

/** Throws if the fee has never been read from chain: never assume a fee. */
export function marketFeeBps(db: Db): bigint {
  const v = kvGet<number | null>(db, 'market.feeBps', null)
  if (v === null) throw new Error('market fee not yet read from chain')
  return BigInt(v)
}

export function feesFor(db: Db, collection: string): FeeSchedule {
  const c = getCollection(db, collection)
  return { marketFeeBps: marketFeeBps(db), royaltyBps: BigInt(c?.royaltyBps ?? 0) }
}
