import type { Db } from '../../db'
import type { NormalizedEventType, NormalizedMarketplaceEvent } from '../events/normalized'
import type { MarketplaceRef, AssetAmount } from '../types'

export const ARC_MARKETPLACE_REF: MarketplaceRef = {
  marketplaceId: 'arc-market',
  chain: { id: '5042002', family: 'evm' },
}

const USDC_ID = 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000'
const text = (value: unknown): string | undefined => value === undefined || value === null ? undefined : String(value)

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function normalizedType(eventName: string): NormalizedEventType {
  switch (eventName) {
    case 'CollectionCreated': return 'collection-created'
    case 'Minted': return 'mint'
    case 'Transfer': return 'transfer'
    case 'Listed': return 'listing-created'
    case 'ListingUpdated': return 'listing-updated'
    case 'ListingCancelled': return 'listing-cancelled'
    case 'Sale': return 'sale'
    case 'OfferMade': return 'offer-created'
    case 'OfferUpdated': return 'offer-updated'
    case 'OfferCancelled': return 'offer-cancelled'
    default: return 'unknown'
  }
}

function amount(value: unknown): AssetAmount | undefined {
  if (value === undefined || value === null) return undefined
  return { amount: String(value), currencyId: USDC_ID, decimals: 6 }
}

/** Convert one existing indexed Arc log to the provider-neutral event vocabulary. */
export function normalizeArcEvent(input: {
  id: number | string
  block: number
  log_index: number
  tx_hash: string
  address: string
  name: string
  args: string
  ts: number
}): NormalizedMarketplaceEvent {
  const args = parseArgs(input.args)
  const tokenId = text(args.tokenId)
  const saleLike = input.name === 'Sale' || input.name === 'OfferAccepted'
  const offerId = text(args.offerId)
  return {
    id: `${input.tx_hash}:${input.log_index}`,
    marketplace: ARC_MARKETPLACE_REF,
    source: 'chain-log',
    sourceEventType: input.name,
    type: normalizedType(input.name),
    occurredAt: new Date(input.ts * 1000).toISOString(),
    collectionId: text(args.collection) ?? (input.name === 'Revealed' ? input.address.toLowerCase() : undefined),
    contractAddress: input.address.toLowerCase(),
    tokenId,
    actor: text(args.seller) ?? text(args.bidder) ?? text(args.creator) ?? text(args.from),
    counterparty: text(args.buyer) ?? text(args.to),
    price: saleLike ? amount(args.price) : undefined,
    transactionHash: input.tx_hash,
    logIndex: input.log_index,
    raw: { block: input.block, address: input.address, args, offerId },
  }
}

export interface ArcActivityQuery {
  collectionId?: string
  eventTypes?: string[]
  after?: number
  before?: number
  nowSec?: number
}

/** Reads only the existing events projection; does not mutate indexed or trading state. */
export function readArcActivity(db: Db, query: ArcActivityQuery = {}): NormalizedMarketplaceEvent[] {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (query.collectionId) {
    clauses.push('address = ?')
    params.push(query.collectionId.toLowerCase())
  }
  if (query.after !== undefined) {
    clauses.push('ts >= ?')
    params.push(query.after)
  }
  if (query.before !== undefined) {
    clauses.push('ts <= ?')
    params.push(query.before)
  }
  if (query.nowSec !== undefined) {
    clauses.push('ts <= ?')
    params.push(query.nowSec)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.query(`SELECT id, block, log_index, tx_hash, address, name, args, ts FROM events ${where} ORDER BY ts DESC, id DESC LIMIT 500`)
    .all(...params) as Array<{
      id: number; block: number; log_index: number; tx_hash: string; address: string; name: string; args: string; ts: number
    }>
  const allowedTypes = query.eventTypes ? new Set(query.eventTypes) : null
  return rows
    .map(normalizeArcEvent)
    .filter((event) => !allowedTypes || allowedTypes.has(event.type) || allowedTypes.has(event.sourceEventType))
}
