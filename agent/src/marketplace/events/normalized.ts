import type { AssetAmount, MarketplaceRef } from '../types'

export type NormalizedEventType =
  | 'collection-created'
  | 'mint'
  | 'transfer'
  | 'listing-created'
  | 'listing-updated'
  | 'listing-cancelled'
  | 'sale'
  | 'offer-created'
  | 'offer-updated'
  | 'offer-cancelled'
  | 'unknown'

export type EventSource = 'chain-log' | 'marketplace-api' | 'mock'

/** Provider-agnostic event projection; `raw` always retains source provenance. */
export interface NormalizedMarketplaceEvent {
  id: string
  marketplace: MarketplaceRef
  source: EventSource
  sourceEventType: string
  type: NormalizedEventType
  occurredAt: string
  collectionId?: string
  contractAddress?: string
  tokenId?: string
  actor?: string
  counterparty?: string
  price?: AssetAmount
  transactionHash?: string
  logIndex?: number
  raw?: unknown
}
