import type { OpenSeaReadOnlyAdapter } from './opensea-readonly'

export type ReadOnlyOpenSeaAdapter = Pick<OpenSeaReadOnlyAdapter,
  | 'listCollections'
  | 'getCollection'
  | 'getCollectionStats'
  | 'getFloorPrices'
  | 'listNfts'
  | 'getNft'
  | 'search'
  | 'getTopCollections'
  | 'getTrendingCollections'
  | 'getActivity'
>

/** Read-only OpenSea API v2 DTO envelopes; payload fields remain forward-compatible. */
export interface OpenSeaPage<T> {
  [key: string]: unknown
  collections?: T[]
  nfts?: T[]
  events?: T[]
  next?: string | null
}

export interface OpenSeaCollection extends Record<string, unknown> {
  collection?: string
  name?: string
  description?: string
  image_url?: string
  contracts?: Array<Record<string, unknown>>
  stats?: Record<string, unknown>
}

export interface OpenSeaNft extends Record<string, unknown> {
  identifier?: string
  collection?: string
  contract?: string
  name?: string
  description?: string
  image_url?: string
  display_image_url?: string
  metadata_url?: string
  traits?: Array<Record<string, unknown>>
}

export interface OpenSeaStats extends Record<string, unknown> {
  total?: Record<string, unknown>
  intervals?: Array<Record<string, unknown>>
}

export interface OpenSeaActivity extends Record<string, unknown> {
  event_type?: string
  event_timestamp?: string
  nft?: OpenSeaNft
  payment?: Record<string, unknown>
}

export interface OpenSeaPageQuery {
  limit?: number
  cursor?: string
}

export interface OpenSeaActivityQuery extends OpenSeaPageQuery {
  eventType?: string
  after?: number
  before?: number
  collection?: string
}

export interface ReadOnlyTransactionOperation {
  readonly enabled: false
  execute(): never
}
