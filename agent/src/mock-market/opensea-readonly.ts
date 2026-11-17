import {
  NotImplementedException,
} from './adapter'
import type {
  OpenSeaActivity, OpenSeaActivityQuery, OpenSeaCollection, OpenSeaNft, OpenSeaPage, OpenSeaPageQuery, OpenSeaStats,
} from './opensea-readonly-types'

const API_BASE = 'https://api.opensea.io/api/v2/'
const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20
const CHAIN_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const COLLECTION_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class OpenSeaApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: string | null = null) {
    super(message)
    this.name = 'OpenSeaApiError'
  }
}

function checkedLimit(value?: number): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  return value
}

function checkedSlug(value: string, label: string): string {
  if (!CHAIN_SLUG.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function checkedCollection(value: string): string {
  if (!COLLECTION_SLUG.test(value)) throw new Error('Invalid collection slug')
  return value
}

function checkedAddress(value: string): string {
  if (!ADDRESS.test(value)) throw new Error('Invalid contract address')
  return value
}

/**
 * Read-only OpenSea API v2 adapter. The API key is backend-only and only used on fixed GET paths.
 * No wallet, RPC, transaction, order-signing, or write endpoint is used here.
 */
export class OpenSeaReadOnlyAdapter {
  readonly marketplace = 'opensea-api-v2-read-only' as const
  readonly mode = 'read-only' as const
  private readonly fetcher: FetchLike

  constructor(
    private readonly apiKey = process.env.OPENSEA_API_KEY ?? '',
    fetcher?: FetchLike,
    private readonly timeoutMs = 12_000,
  ) {
    this.fetcher = fetcher ?? fetch
  }

  async listCollections(query: OpenSeaPageQuery & { chain?: string } = {}): Promise<OpenSeaPage<OpenSeaCollection>> {
    const params = this.pageParams(query)
    if (query.chain) params.set('chain', checkedSlug(query.chain, 'chain slug'))
    return this.get('collections', params)
  }

  async getCollection(slug: string): Promise<OpenSeaCollection> {
    return this.get(`collections/${checkedCollection(slug)}`)
  }

  async getCollectionStats(slug: string): Promise<OpenSeaStats> {
    return this.get(`collections/${checkedCollection(slug)}/stats`)
  }

  async getFloorPrices(slug: string, query: OpenSeaPageQuery = {}): Promise<OpenSeaPage<Record<string, unknown>>> {
    return this.get(`collections/${checkedCollection(slug)}/floor_prices`, this.pageParams(query))
  }

  async listNfts(chain: string, contractAddress: string, query: OpenSeaPageQuery = {}): Promise<OpenSeaPage<OpenSeaNft>> {
    return this.get(`chain/${checkedSlug(chain, 'chain slug')}/contract/${checkedAddress(contractAddress)}/nfts`, this.pageParams(query))
  }

  async getNft(chain: string, contractAddress: string, identifier: string): Promise<{ nft: OpenSeaNft }> {
    if (!/^\d{1,78}$/.test(identifier)) throw new Error('NFT identifier must be an unsigned integer string')
    return this.get(`chain/${checkedSlug(chain, 'chain slug')}/contract/${checkedAddress(contractAddress)}/nfts/${identifier}`)
  }

  async search(query: string, options: OpenSeaPageQuery & { chains?: string[] } = {}): Promise<Record<string, unknown>> {
    const text = query.trim()
    if (!text || text.length > 200) throw new Error('Search query must contain 1 to 200 characters')
    const params = this.pageParams(options)
    params.set('query', text)
    if (options.chains?.length) params.set('chains', options.chains.map((chain) => checkedSlug(chain, 'chain slug')).join(','))
    return this.get('search', params)
  }

  async getTopCollections(query: OpenSeaPageQuery & { chain?: string } = {}): Promise<OpenSeaPage<OpenSeaCollection>> {
    const params = this.pageParams(query)
    if (query.chain) params.set('chain', checkedSlug(query.chain, 'chain slug'))
    return this.get('collections/top', params)
  }

  async getTrendingCollections(query: OpenSeaPageQuery & { chain?: string } = {}): Promise<OpenSeaPage<OpenSeaCollection>> {
    const params = this.pageParams(query)
    if (query.chain) params.set('chain', checkedSlug(query.chain, 'chain slug'))
    return this.get('collections/trending', params)
  }

  async getActivity(query: OpenSeaActivityQuery): Promise<OpenSeaPage<OpenSeaActivity>> {
    const params = this.pageParams(query)
    if (query.eventType) params.set('event_type', query.eventType)
    if (query.after !== undefined) params.set('after', String(this.unixSeconds(query.after, 'after')))
    if (query.before !== undefined) params.set('before', String(this.unixSeconds(query.before, 'before')))
    if (query.collection) {
      return this.get(`events/collection/${checkedCollection(query.collection)}`, params)
    }
    return this.get('events', params)
  }

  /** Explicitly unavailable: read-only integrations must never place orders. */
  buy(_listingId: string): never { throw new NotImplementedException('OpenSea read-only adapter: buy is disabled') }
  sell(_input: unknown): never { throw new NotImplementedException('OpenSea read-only adapter: listing creation is disabled') }
  cancel(_orderId: string): never { throw new NotImplementedException('OpenSea read-only adapter: cancellation is disabled') }
  transfer(_input: unknown): never { throw new NotImplementedException('OpenSea read-only adapter: transfers are disabled') }
  createListing(_input: unknown): never { throw new NotImplementedException('OpenSea read-only adapter: listing creation is disabled') }
  createOffer(_input: unknown): never { throw new NotImplementedException('OpenSea read-only adapter: offer creation is disabled') }

  private pageParams(query: OpenSeaPageQuery): URLSearchParams {
    const params = new URLSearchParams()
    params.set('limit', String(checkedLimit(query.limit)))
    if (query.cursor) {
      if (query.cursor.length > 2048) throw new Error('Pagination cursor is too long')
      params.set('next', query.cursor)
    }
    return params
  }

  private unixSeconds(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative Unix timestamp`)
    return value
  }

  private async get<T>(path: string, params = new URLSearchParams()): Promise<T> {
    if (!this.apiKey) throw new OpenSeaApiError('OpenSea API key is not configured', 503)
    // All URL paths are constructed from validated path segments; hosts are fixed to OpenSea.
    const url = new URL(path, API_BASE)
    url.search = params.toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-api-key': this.apiKey },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new OpenSeaApiError(
          `OpenSea read request failed with status ${response.status}`,
          response.status,
          response.headers.get('retry-after'),
        )
      }
      return await response.json() as T
    } catch (error) {
      if (error instanceof OpenSeaApiError) throw error
      if (controller.signal.aborted) throw new OpenSeaApiError('OpenSea read request timed out', 504)
      throw new OpenSeaApiError('OpenSea read request failed', 502)
    } finally {
      clearTimeout(timeout)
    }
  }
}
