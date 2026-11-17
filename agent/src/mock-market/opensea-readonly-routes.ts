import { OpenSeaApiError, OpenSeaReadOnlyAdapter } from './opensea-readonly'

const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...Object.fromEntries(new Headers(headers).entries()) },
})
const required = (value: string | null, label: string): string => {
  if (!value) throw new Error(`Missing query parameter: ${label}`)
  return value
}
const optionalLimit = (value: string | null): number | undefined => value === null ? undefined : Number(value)

/**
 * Read-only API routes. No POST/PATCH/DELETE route exists and only GETs reach OpenSea.
 * Inject adapter for tests; production API keys remain server-side.
 */
export function createOpenSeaReadOnlyRoutes(adapter = new OpenSeaReadOnlyAdapter()) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, '') || '/'
    if (request.method !== 'GET') return json({ error: 'read-only endpoint; only GET is allowed' }, 405, { allow: 'GET' })
    const page = { limit: optionalLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor') ?? undefined }
    try {
      if (path === '/collections') {
        return json(await adapter.listCollections({ ...page, chain: url.searchParams.get('chain') ?? undefined }))
      }
      const stats = /^\/collections\/([^/]+)\/stats$/.exec(path)
      if (stats) return json(await adapter.getCollectionStats(decodeURIComponent(stats[1])))
      const floors = /^\/collections\/([^/]+)\/floor_prices$/.exec(path)
      if (floors) return json(await adapter.getFloorPrices(decodeURIComponent(floors[1]), page))
      const collection = /^\/collections\/([^/]+)$/.exec(path)
      if (collection) return json(await adapter.getCollection(decodeURIComponent(collection[1])))
      if (path === '/nfts') {
        return json(await adapter.listNfts(
          required(url.searchParams.get('chain'), 'chain'),
          required(url.searchParams.get('contract'), 'contract'), page,
        ))
      }
      const nft = /^\/nfts\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path)
      if (nft) return json(await adapter.getNft(decodeURIComponent(nft[1]), decodeURIComponent(nft[2]), decodeURIComponent(nft[3])))
      if (path === '/search') {
        const chains = url.searchParams.getAll('chain')
        return json(await adapter.search(required(url.searchParams.get('query'), 'query'), { ...page, chains }))
      }
      if (path === '/rankings/top') return json(await adapter.getTopCollections({ ...page, chain: url.searchParams.get('chain') ?? undefined }))
      if (path === '/rankings/trending') return json(await adapter.getTrendingCollections({ ...page, chain: url.searchParams.get('chain') ?? undefined }))
      if (path === '/activity') {
        return json(await adapter.getActivity({
          ...page,
          eventType: url.searchParams.get('event_type') ?? undefined,
          collection: url.searchParams.get('collection') ?? undefined,
          after: url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined,
          before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined,
        }))
      }
      return json({ error: 'not found' }, 404)
    } catch (error) {
      if (error instanceof OpenSeaApiError) {
        const headers = error.retryAfter ? { 'retry-after': error.retryAfter } : undefined
        return json({ error: error.message }, error.status, headers)
      }
      return json({ error: error instanceof Error ? error.message : 'OpenSea read request failed' }, 400)
    }
  }
}

export const handleOpenSeaReadOnlyRequest = createOpenSeaReadOnlyRoutes()
