import type { ChainRef } from '../chain/types'
import type { MarketplaceCapabilities } from './capabilities'
import type { Action } from '../types'
import type { NormalizedMarketplaceEvent } from './events/normalized'

export type MarketplaceId = string
export type ProviderEntityId = string
export type PaginationCursor = string

export interface MarketplaceRef {
  /** Stable adapter/provider identifier, e.g. `arc-market` or `opensea`. */
  marketplaceId: MarketplaceId
  chain: ChainRef
}

export interface PageQuery {
  limit?: number
  cursor?: PaginationCursor
}

export interface Page<T> {
  items: T[]
  nextCursor: PaginationCursor | null
}

export interface AssetAmount {
  /** Integer quantity in the denomination's smallest units, represented as a decimal string. */
  amount: string
  currencyId: string
  decimals: number
}

export interface CollectionQuery extends PageQuery {
  chain?: ChainRef
  creator?: string
  orderBy?: 'createdAt' | 'volume' | 'floorPrice'
}

export interface CollectionDto {
  ref: MarketplaceRef
  id: ProviderEntityId
  name: string
  description?: string
  imageUrl?: string
  externalUrl?: string
  contractAddress?: string
  verified?: boolean
  stats?: CollectionStatsDto
  /** Provider-specific collection data. Must not be used as execution authorization. */
  raw?: unknown
}

export interface CollectionStatsDto {
  floorPrice?: AssetAmount | null
  volume?: AssetAmount | null
  averagePrice?: AssetAmount | null
  totalSupply?: number
  owners?: number
  sales?: number
  observedAt?: string
}

export interface FloorPointDto {
  timestamp: string
  floorPrice: AssetAmount
}

export interface NftQuery extends PageQuery {
  collectionId?: ProviderEntityId
  contractAddress?: string
  owner?: string
}

export interface NftDto {
  ref: MarketplaceRef
  collectionId: ProviderEntityId
  tokenId: string
  name?: string
  description?: string
  imageUrl?: string
  animationUrl?: string
  metadataUrl?: string
  owner?: string
  traits?: Array<{ traitType: string; value: string | number; displayType?: string }>
  raw?: unknown
}

export interface ListingQuery extends PageQuery {
  collectionId?: ProviderEntityId
  contractAddress?: string
  tokenId?: string
  maker?: string
}

export interface ListingDto {
  ref: MarketplaceRef
  id: ProviderEntityId
  collectionId: ProviderEntityId
  contractAddress?: string
  tokenId: string
  maker?: string
  price: AssetAmount
  createdAt?: string
  expiresAt?: string
  status: 'active' | 'inactive' | 'unknown'
  raw?: unknown
}

export interface SearchQuery extends PageQuery {
  query: string
  chains?: ChainRef[]
  assetTypes?: Array<'collection' | 'nft' | 'token' | 'account'>
}

export interface SearchResultDto {
  type: 'collection' | 'nft' | 'token' | 'account' | 'unknown'
  id: ProviderEntityId
  name?: string
  ref?: MarketplaceRef
  raw?: unknown
}

export interface RankingQuery extends PageQuery {
  chain?: ChainRef
  period?: 'day' | 'week' | 'month' | 'all'
  orderBy?: 'volume' | 'floorPrice' | 'sales'
}

export interface ActivityQuery extends PageQuery {
  chain?: ChainRef
  collectionId?: ProviderEntityId
  eventTypes?: string[]
  after?: number
  before?: number
}

export interface MarketplaceReadAdapter {
  readonly ref: MarketplaceRef
  readonly capabilities: MarketplaceCapabilities
  listCollections(query?: CollectionQuery): Promise<Page<CollectionDto>>
  getCollection(id: ProviderEntityId): Promise<CollectionDto | null>
  getCollectionStats(id: ProviderEntityId): Promise<CollectionStatsDto>
  getFloorHistory(id: ProviderEntityId, query?: PageQuery): Promise<Page<FloorPointDto>>
  listNfts(query: NftQuery): Promise<Page<NftDto>>
  getNft(collectionId: ProviderEntityId, tokenId: string): Promise<NftDto | null>
  listListings(query: ListingQuery): Promise<Page<ListingDto>>
  search(query: SearchQuery): Promise<Page<SearchResultDto>>
  getRankings(query: RankingQuery): Promise<Page<CollectionDto>>
  getActivity(query: ActivityQuery): Promise<Page<NormalizedMarketplaceEvent>>
}

/**
 * Execution adapter contract for a separately reviewed marketplace implementation.
 * Phase 1 only defines this type. Existing Arc execution stays in ExecutionService and
 * agent/src/exec/policy.ts; no adapter is wired or granted new transaction permissions here.
 */
export interface ExecutionAdapter {
  readonly marketplace: MarketplaceRef
  readonly capabilities: MarketplaceCapabilities
  execute(action: Action): Promise<ExecutionReceipt>
}

export interface ExecutionReceipt {
  status: 'submitted' | 'confirmed' | 'failed'
  transactionId?: string
  transactionHash?: string
  error?: string
}

export interface MarketplaceRegistration {
  read: MarketplaceReadAdapter
  /** Absent for read-only integrations such as OpenSea. */
  execution?: ExecutionAdapter
}
