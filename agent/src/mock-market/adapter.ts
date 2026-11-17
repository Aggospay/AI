import type {
  ListingQuery, MockCollection, MockListing, MockNetworkId, MockNft, MockOperationResult, MockOrder,
  MockOrderDraftInput, OrderQuery, Page,
} from './models'

export class NotImplementedException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplementedException'
  }
}

/** Adapter contract is read/mock only. Implementations must not sign or send transactions. */
export interface MarketplaceAdapter {
  readonly marketplace: string
  readonly mode: 'mock'
  listNetworks(): MockNetworkId[]
  listListings(query: ListingQuery): Page<MockListing>
  getCollection(chain: MockNetworkId, slug: string): MockCollection | null
  listCollections(chain: MockNetworkId): MockCollection[]
  getNft(chain: MockNetworkId, contractAddress: string, tokenId: string): MockNft | null
  listOrders(query: OrderQuery): Page<MockOrder>
  createMockOrder(input: MockOrderDraftInput): MockOrder
  buy(listingId: string): Promise<MockOperationResult>
  sell(input: MockOrderDraftInput): Promise<MockOperationResult>
  cancel(orderHash: string): Promise<MockOperationResult>
  transfer(input: { chain: MockNetworkId; contractAddress: string; tokenId: string; to: string }): Promise<MockOperationResult>
}
