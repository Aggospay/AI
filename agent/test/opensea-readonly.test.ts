import { describe, expect, test } from 'bun:test'
import { NotImplementedException } from '../src/mock-market/adapter'
import { OpenSeaApiError, OpenSeaReadOnlyAdapter } from '../src/mock-market/opensea-readonly'
import { createOpenSeaReadOnlyRoutes } from '../src/mock-market/opensea-readonly-routes'

function response(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers).entries()) } })
}

describe('OpenSea read-only adapter', () => {
  test('uses fixed API host, API key header, GET and cursor pagination', async () => {
    let captured: { url: string; init?: RequestInit } | undefined
    const adapter = new OpenSeaReadOnlyAdapter('secret-test-key', async (input, init) => {
      captured = { url: String(input), init }
      return response({ collections: [], next: 'cursor-2' })
    })
    const result = await adapter.listCollections({ chain: 'ethereum', limit: 10, cursor: 'cursor-1' })
    expect(new URL(captured!.url).hostname).toBe('api.opensea.io')
    expect(new URL(captured!.url).pathname).toBe('/api/v2/collections')
    expect(new URL(captured!.url).searchParams.get('next')).toBe('cursor-1')
    expect((captured!.init?.headers as Record<string, string>)['x-api-key']).toBe('secret-test-key')
    expect(captured!.init?.method).toBe('GET')
    expect(result.next).toBe('cursor-2')
  })

  test('reads all supported resource categories through GET routes', async () => {
    const paths: string[] = []
    const adapter = new OpenSeaReadOnlyAdapter('key', async (input) => {
      paths.push(new URL(String(input)).pathname)
      return response({ ok: true })
    })
    await adapter.getCollection('sample-collection')
    await adapter.getCollectionStats('sample-collection')
    await adapter.getFloorPrices('sample-collection')
    await adapter.getNft('ethereum', '0x0000000000000000000000000000000000000001', '123')
    await adapter.search('cats', { chains: ['base'] })
    await adapter.getTopCollections({ chain: 'ethereum' })
    await adapter.getTrendingCollections({ chain: 'base' })
    await adapter.getActivity({ collection: 'sample-collection', eventType: 'sale', after: 100 })
    expect(paths).toEqual([
      '/api/v2/collections/sample-collection',
      '/api/v2/collections/sample-collection/stats',
      '/api/v2/collections/sample-collection/floor_prices',
      '/api/v2/chain/ethereum/contract/0x0000000000000000000000000000000000000001/nfts/123',
      '/api/v2/search', '/api/v2/collections/top', '/api/v2/collections/trending',
      '/api/v2/events/collection/sample-collection',
    ])
  })

  test('rejects invalid path segments and oversized pagination before fetch', async () => {
    const adapter = new OpenSeaReadOnlyAdapter('key', async () => { throw new Error('must not fetch') })
    await expect(adapter.getCollection('../settings')).rejects.toThrow('Invalid collection slug')
    await expect(adapter.listNfts('https://evil.example', '0x0000000000000000000000000000000000000001')).rejects.toThrow('Invalid chain slug')
    await expect(adapter.listCollections({ limit: 51 })).rejects.toThrow('limit must be an integer')
  })

  test('fails closed without key and preserves upstream status/retry information', async () => {
    await expect(new OpenSeaReadOnlyAdapter('').listCollections()).rejects.toMatchObject({ status: 503 })
    const limited = new OpenSeaReadOnlyAdapter('key', async () => response({}, 429, { 'retry-after': '5' }))
    await expect(limited.listCollections()).rejects.toMatchObject({ status: 429, retryAfter: '5' })
    const unavailable = new OpenSeaReadOnlyAdapter('key', async () => { throw new Error('transport problem') })
    await expect(unavailable.listCollections()).rejects.toBeInstanceOf(OpenSeaApiError)
  })

  test('all transaction-like methods throw and never call fetch', () => {
    const adapter = new OpenSeaReadOnlyAdapter('key', async () => { throw new Error('not expected') })
    expect(() => adapter.buy('listing')).toThrow(NotImplementedException)
    expect(() => adapter.sell({})).toThrow(NotImplementedException)
    expect(() => adapter.cancel('order')).toThrow(NotImplementedException)
    expect(() => adapter.transfer({})).toThrow(NotImplementedException)
    expect(() => adapter.createListing({})).toThrow(NotImplementedException)
    expect(() => adapter.createOffer({})).toThrow(NotImplementedException)
  })

  test('read-only routes reject every non-GET before any API call', async () => {
    let fetched = false
    const adapter = new OpenSeaReadOnlyAdapter('key', async () => { fetched = true; return response({}) })
    const route = createOpenSeaReadOnlyRoutes(adapter)
    const result = await route(new Request('http://localhost/collections', { method: 'POST' }))
    expect(result.status).toBe(405)
    expect(result.headers.get('allow')).toBe('GET')
    expect(fetched).toBe(false)
  })
})
