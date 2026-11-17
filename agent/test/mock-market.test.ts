import { describe, expect, test } from 'bun:test'
import { OpenSeaMockAdapter } from '../src/mock-market/opensea-mock-adapter'
import { InMemoryMarketplaceRepository } from '../src/mock-market/repository'
import { MockListingService, MockOrderService } from '../src/mock-market/services'
import { handleMockMarketplaceRequest } from '../src/mock-market/routes'

describe('OpenSea-compatible mock adapter', () => {
  const adapter = new OpenSeaMockAdapter(new InMemoryMarketplaceRepository(['ethereum', 'base']))

  test('supports multiple isolated mock networks and returns sample models', () => {
    expect(adapter.listNetworks()).toEqual(['ethereum', 'base'])
    expect(adapter.listCollections('ethereum')[0].name).toBe('Mock Creatures')
    expect(adapter.getNft('base', '0x0000000000000000000000000000000000000abc', '1')?.metadata.name).toBe('Mock Creature #1')
    expect(adapter.listListings({ chain: 'ethereum' }).items.length).toBeGreaterThan(0)
  })

  test('filters, sorts and paginates mock listings', () => {
    const first = adapter.listListings({ chain: 'ethereum', collection: 'mock-creatures', minPrice: '0.4', sortBy: 'price', direction: 'desc', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(Number(first.items[0].price.quantity)).toBeGreaterThan(Number(first.items[1].price.quantity))
    expect(first.nextCursor).not.toBeNull()
    const next = adapter.listListings({ chain: 'ethereum', collection: 'mock-creatures', minPrice: '0.4', sortBy: 'price', direction: 'desc', limit: 2, cursor: first.nextCursor })
    expect(next.items[0].id).not.toBe(first.items[0].id)
  })

  test('transaction-like methods only return explicit no-op mock results', async () => {
    const result = await adapter.buy('mock-listing-ethereum-1')
    expect(result.mode).toBe('mock')
    expect(result.accepted).toBe(false)
    expect(result.message).toContain('No wallet, signature, asset, or blockchain transaction')
    const transfer = await adapter.transfer({ chain: 'base', contractAddress: '0xabc', tokenId: '1', to: '0xdef' })
    expect(transfer.operation).toBe('transfer')
    expect(transfer.accepted).toBe(false)
  })

  test('order service creates local draft records and cancel remains a no-op', async () => {
    const repository = new InMemoryMarketplaceRepository(['ethereum'])
    const localAdapter = new OpenSeaMockAdapter(repository)
    const orders = new MockOrderService(localAdapter)
    const draft = orders.createDraft({
      chain: 'ethereum', side: 'listing', collectionSlug: 'mock-creatures',
      contractAddress: '0x0000000000000000000000000000000000000abc', tokenId: '1',
      maker: '0x00000000000000000000000000000000000000a1', price: { quantity: '1', unit: 'ETH' },
    })
    expect(draft.status).toBe('draft')
    expect(orders.browse({ chain: 'ethereum', status: 'draft' }).items[0].orderHash).toBe(draft.orderHash)
    const result = await orders.cancel(draft.orderHash)
    expect(result.accepted).toBe(false)
    expect(orders.browse({ chain: 'ethereum', status: 'draft' }).items).toHaveLength(1)
  })

  test('standalone example routes expose mock fixtures and safely reject unsupported network', async () => {
    const networks = await handleMockMarketplaceRequest(new Request('http://localhost/networks'))
    expect((await networks.json() as { mode: string }).mode).toBe('mock')
    const listings = await handleMockMarketplaceRequest(new Request('http://localhost/listings?chain=base&limit=1'))
    expect((await listings.json() as { items: unknown[] }).items).toHaveLength(1)
    const unsupported = await handleMockMarketplaceRequest(new Request('http://localhost/listings?chain=unknown'))
    expect(unsupported.status).toBe(400)
  })
})
