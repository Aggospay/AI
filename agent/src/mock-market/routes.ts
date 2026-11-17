import { mockListingService, mockMarketplaceAdapter, mockOrderService } from './index'
import type { ListingQuery, MockOrderDraftInput, OrderQuery } from './models'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})
const required = (value: string | null, name: string): string => {
  if (!value) throw new Error(`Missing query parameter: ${name}`)
  return value
}

/** Standalone mock API routes. No chain, wallet, production server or transaction module imported. */
export async function handleMockMarketplaceRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '') || '/'
  try {
    if (request.method === 'GET' && path === '/networks') return json({ mode: 'mock', networks: mockMarketplaceAdapter.listNetworks() })
    if (request.method === 'GET' && path === '/listings') {
      const query: ListingQuery = {
        chain: required(url.searchParams.get('chain'), 'chain'),
        collection: url.searchParams.get('collection') ?? undefined,
        maker: url.searchParams.get('maker') ?? undefined,
        minPrice: url.searchParams.get('minPrice') ?? undefined,
        maxPrice: url.searchParams.get('maxPrice') ?? undefined,
        sortBy: (url.searchParams.get('sortBy') as ListingQuery['sortBy']) ?? 'price',
        direction: (url.searchParams.get('direction') as ListingQuery['direction']) ?? 'asc',
        limit: Number(url.searchParams.get('limit') ?? 20), cursor: url.searchParams.get('cursor'),
      }
      if (query.sortBy !== 'price' && query.sortBy !== 'createdAt') throw new Error('sortBy must be price or createdAt')
      if (query.direction !== 'asc' && query.direction !== 'desc') throw new Error('direction must be asc or desc')
      return json({ mode: 'mock', ...mockListingService.browse(query) })
    }
    if (request.method === 'GET' && path === '/collections') {
      const chain = required(url.searchParams.get('chain'), 'chain')
      return json({ mode: 'mock', collections: mockMarketplaceAdapter.listCollections(chain) })
    }
    const collection = /^\/collections\/([^/]+)$/.exec(path)
    if (request.method === 'GET' && collection) {
      const chain = required(url.searchParams.get('chain'), 'chain')
      const result = mockMarketplaceAdapter.getCollection(chain, decodeURIComponent(collection[1]))
      return result ? json({ mode: 'mock', collection: result }) : json({ error: 'mock collection not found' }, 404)
    }
    const nft = /^\/nfts\/([^/]+)\/([^/]+)$/.exec(path)
    if (request.method === 'GET' && nft) {
      const chain = required(url.searchParams.get('chain'), 'chain')
      const result = mockMarketplaceAdapter.getNft(chain, decodeURIComponent(nft[1]), decodeURIComponent(nft[2]))
      return result ? json({ mode: 'mock', nft: result }) : json({ error: 'mock NFT not found' }, 404)
    }
    if (request.method === 'GET' && path === '/orders') {
      const query: OrderQuery = {
        chain: required(url.searchParams.get('chain'), 'chain'),
        side: (url.searchParams.get('side') as OrderQuery['side']) ?? undefined,
        status: (url.searchParams.get('status') as OrderQuery['status']) ?? undefined,
        collection: url.searchParams.get('collection') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 20), cursor: url.searchParams.get('cursor'),
      }
      return json({ mode: 'mock', ...mockOrderService.browse(query) })
    }
    if (request.method === 'POST' && path === '/orders') {
      const body = await request.json() as MockOrderDraftInput
      const draft = mockOrderService.createDraft(body)
      return json({ mode: 'mock', order: draft, warning: 'Draft only; no signature or transaction was created.' }, 201)
    }
    const action = /^\/actions\/(buy|sell|cancel|transfer)$/.exec(path)
    if (request.method === 'POST' && action) {
      const body = await request.json() as Record<string, unknown>
      let result
      switch (action[1]) {
        case 'buy': result = await mockListingService.buy(String(body.listingId ?? 'mock-unspecified')); break
        case 'sell': result = await mockListingService.sell(body as unknown as MockOrderDraftInput); break
        case 'cancel': result = await mockOrderService.cancel(String(body.orderHash ?? 'mock-unspecified')); break
        case 'transfer': result = await mockOrderService.transfer({
          chain: String(body.chain ?? ''), contractAddress: String(body.contractAddress ?? ''),
          tokenId: String(body.tokenId ?? ''), to: String(body.to ?? ''),
        }); break
      }
      return json(result)
    }
    return json({ error: 'not found' }, 404)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'mock marketplace request failed' }, 400)
  }
}
