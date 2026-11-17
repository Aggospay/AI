/** OpenSea-shaped mock DTOs. These are local models only; no OpenSea API is called. */
export type MockNetworkId = string
export type SortDirection = 'asc' | 'desc'
export type ListingSort = 'price' | 'createdAt'
export type MockOrderSide = 'listing' | 'offer'
export type MockOrderStatus = 'draft' | 'active' | 'cancelled' | 'fulfilled'

export interface NftMetadata {
  name: string
  description: string
  imageUrl: string
  animationUrl?: string
  externalUrl?: string
  attributes: Array<{ traitType: string; value: string | number; displayType?: string }>
}

export interface MockNft {
  chain: MockNetworkId
  contractAddress: string
  tokenId: string
  collectionSlug: string
  metadata: NftMetadata
  owner: string
  updatedAt: string
}

export interface MockCollection {
  chain: MockNetworkId
  slug: string
  name: string
  description: string
  imageUrl: string
  externalUrl: string
  contractAddress: string
  tokenStandard: 'ERC721' | 'ERC1155'
  totalSupply: number
  floorPrice: { quantity: string; unit: string } | null
  createdAt: string
}

export interface MockListing {
  id: string
  chain: MockNetworkId
  collectionSlug: string
  contractAddress: string
  tokenId: string
  maker: string
  price: { quantity: string; unit: string }
  createdAt: string
  expiresAt: string
  status: 'active' | 'inactive'
  nft: MockNft
}

export interface MockOrder {
  orderHash: string
  chain: MockNetworkId
  side: MockOrderSide
  collectionSlug: string
  contractAddress: string
  tokenId: string | null
  maker: string
  price: { quantity: string; unit: string }
  createdAt: string
  status: MockOrderStatus
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total: number
}

export interface ListingQuery {
  chain: MockNetworkId
  collection?: string
  maker?: string
  minPrice?: string
  maxPrice?: string
  sortBy?: ListingSort
  direction?: SortDirection
  limit?: number
  cursor?: string | null
}

export interface OrderQuery {
  chain: MockNetworkId
  side?: MockOrderSide
  status?: MockOrderStatus
  collection?: string
  limit?: number
  cursor?: string | null
}

export interface MockOperationResult {
  mode: 'mock'
  operation: 'buy' | 'sell' | 'cancel' | 'transfer'
  accepted: false
  simulatedAt: string
  message: string
  reference: string
}

export interface MockOrderDraftInput {
  chain: MockNetworkId
  side: MockOrderSide
  collectionSlug: string
  contractAddress: string
  tokenId?: string | null
  maker: string
  price: { quantity: string; unit: string }
}
