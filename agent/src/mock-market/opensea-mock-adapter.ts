import type { MarketplaceAdapter } from './adapter'
import { NotImplementedException } from './adapter'
import type {
  ListingQuery, MockCollection, MockListing, MockNetworkId, MockNft, MockOperationResult, MockOrder,
  MockOrderDraftInput, OrderQuery, Page,
} from './models'
import type { MarketplaceRepository } from './repository'

const parsePrice = (value: string): number | null => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function page<T>(items: T[], limit = 20, cursor?: string | null): Page<T> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
  const results = items.slice(offset, offset + safeLimit)
  const next = offset + safeLimit < items.length ? String(offset + safeLimit) : null
  return { items: results, nextCursor: next, total: items.length }
}

function mockResult(operation: MockOperationResult['operation'], reference: string): MockOperationResult {
  return {
    mode: 'mock', operation, accepted: false, simulatedAt: new Date().toISOString(), reference,
    message: `Mock only: ${operation} was not executed. No wallet, signature, asset, or blockchain transaction was used.`,
  }
}

/** Uses OpenSea-style field shapes as DTO inspiration; all reads use local fixtures only. */
export class OpenSeaMockAdapter implements MarketplaceAdapter {
  readonly marketplace = 'opensea-compatible-mock'
  readonly mode = 'mock' as const

  constructor(private readonly repository: MarketplaceRepository) {}

  listNetworks(): MockNetworkId[] { return this.repository.listNetworks() }

  listListings(query: ListingQuery): Page<MockListing> {
    this.assertNetwork(query.chain)
    const min = query.minPrice === undefined ? null : parsePrice(query.minPrice)
    const max = query.maxPrice === undefined ? null : parsePrice(query.maxPrice)
    if ((query.minPrice !== undefined && min === null) || (query.maxPrice !== undefined && max === null)) throw new Error('Price filters must be finite numbers')
    let rows = this.repository.listListings(query.chain).filter((listing) => listing.status === 'active')
    if (query.collection) rows = rows.filter((x) => x.collectionSlug === query.collection)
    if (query.maker) rows = rows.filter((x) => x.maker.toLowerCase() === query.maker!.toLowerCase())
    if (min !== null) rows = rows.filter((x) => (parsePrice(x.price.quantity) ?? -Infinity) >= min)
    if (max !== null) rows = rows.filter((x) => (parsePrice(x.price.quantity) ?? Infinity) <= max)
    const direction = query.direction === 'desc' ? -1 : 1
    rows.sort((a, b) => {
      const comparison = query.sortBy === 'createdAt'
        ? a.createdAt.localeCompare(b.createdAt)
        : (parsePrice(a.price.quantity) ?? 0) - (parsePrice(b.price.quantity) ?? 0)
      return comparison * direction || a.id.localeCompare(b.id)
    })
    return page(rows, query.limit, query.cursor)
  }

  getCollection(chain: MockNetworkId, slug: string): MockCollection | null {
    this.assertNetwork(chain)
    return this.repository.getCollection(chain, slug)
  }

  listCollections(chain: MockNetworkId): MockCollection[] {
    this.assertNetwork(chain)
    return this.repository.listCollections(chain)
  }

  getNft(chain: MockNetworkId, contractAddress: string, tokenId: string): MockNft | null {
    this.assertNetwork(chain)
    return this.repository.getNft(chain, contractAddress, tokenId)
  }

  listOrders(query: OrderQuery): Page<MockOrder> {
    this.assertNetwork(query.chain)
    let rows = this.repository.listOrders(query.chain)
    if (query.side) rows = rows.filter((x) => x.side === query.side)
    if (query.status) rows = rows.filter((x) => x.status === query.status)
    if (query.collection) rows = rows.filter((x) => x.collectionSlug === query.collection)
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return page(rows, query.limit, query.cursor)
  }

  createMockOrder(input: MockOrderDraftInput): MockOrder {
    this.assertNetwork(input.chain)
    if (!this.repository.getCollection(input.chain, input.collectionSlug)) throw new Error('Unknown mock collection')
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.contractAddress) || !/^0x[0-9a-fA-F]{40}$/.test(input.maker)) throw new Error('Mock contract and maker must be EVM-style addresses')
    const quantity = parsePrice(input.price.quantity)
    if (quantity === null || quantity <= 0 || !input.price.unit.trim()) throw new Error('Mock order price must be positive and include a unit')
    const order: MockOrder = {
      orderHash: `mock-draft-${input.chain}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chain: input.chain, side: input.side, collectionSlug: input.collectionSlug, contractAddress: input.contractAddress,
      tokenId: input.tokenId ?? null, maker: input.maker, price: { ...input.price }, createdAt: new Date().toISOString(), status: 'draft',
    }
    this.repository.insertOrder(order)
    return order
  }

  async buy(listingId: string): Promise<MockOperationResult> { return mockResult('buy', listingId) }
  async sell(input: MockOrderDraftInput): Promise<MockOperationResult> { return mockResult('sell', `${input.chain}:${input.collectionSlug}`) }
  async cancel(orderHash: string): Promise<MockOperationResult> { return mockResult('cancel', orderHash) }
  async transfer(input: { chain: MockNetworkId; contractAddress: string; tokenId: string; to: string }): Promise<MockOperationResult> {
    return mockResult('transfer', `${input.chain}:${input.contractAddress}:${input.tokenId}`)
  }

  private assertNetwork(chain: MockNetworkId): void {
    if (!this.repository.listNetworks().includes(chain)) throw new Error(`Unsupported mock network: ${chain}`)
  }
}
