import type { ListingQuery, MockListing, MockNetworkId, MockOrder, MockOrderDraftInput, OrderQuery, Page } from './models'
import type { MarketplaceAdapter } from './adapter'

export class MockListingService {
  constructor(private readonly adapter: MarketplaceAdapter) {}
  browse(query: ListingQuery): Page<MockListing> { return this.adapter.listListings(query) }
  /** Mock-only result. Does not execute a purchase or alter listing state. */
  buy(listingId: string) { return this.adapter.buy(listingId) }
  /** Mock-only result. Does not create a signed or onchain listing. */
  sell(input: MockOrderDraftInput) { return this.adapter.sell(input) }
}

export class MockOrderService {
  constructor(private readonly adapter: MarketplaceAdapter) {}
  browse(query: OrderQuery): Page<MockOrder> { return this.adapter.listOrders(query) }
  createDraft(input: MockOrderDraftInput): MockOrder { return this.adapter.createMockOrder(input) }
  /** Mock-only result. Leaves the draft/order unchanged. */
  cancel(orderHash: string) { return this.adapter.cancel(orderHash) }
  /** Mock-only result. No token transfer is performed. */
  transfer(input: { chain: MockNetworkId; contractAddress: string; tokenId: string; to: string }) {
    return this.adapter.transfer(input)
  }
}
