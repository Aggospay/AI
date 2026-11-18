import { getUsdc } from '../../../../../src/onchain-facts'
import { activeListings, collectionStats, getCollection, listCollections, type CollectionRow } from '../../../analysis/market'
import { defaultSettings, type Settings } from '../../../config'
import type { Db } from '../../../db'
import { ARC_MARKETPLACE_CAPABILITIES } from '../../capabilities'
import type {
  ActivityQuery, CollectionDto, CollectionQuery, CollectionStatsDto, FloorPointDto, ListingDto,
  ListingQuery, MarketplaceReadAdapter, MarketplaceRef, NftDto, NftQuery, Page, PageQuery,
  RankingQuery, SearchQuery, SearchResultDto,
} from '../../types'
import { normalizeArcEvent, readArcActivity } from './events'

export const ARC_MARKETPLACE_REF: MarketplaceRef = {
  marketplaceId: 'arc-market',
  chain: { id: '5042002', family: 'evm' },
}

const USDC = getUsdc(5042002)
const USDC_ID = `eip155:5042002/erc20:${USDC?.address ?? 'arc-usdc'}`
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function page<T>(items: T[], query: PageQuery = {}): Page<T> {
  const limit = query.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  const offset = query.cursor === undefined ? 0 : Number(query.cursor)
  if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== query.cursor) {
    throw new Error('cursor must be a non-negative integer offset')
  }
  return {
    items: items.slice(offset, offset + limit),
    nextCursor: offset + limit < items.length ? String(offset + limit) : null,
  }
}

function money(amount: bigint | null): { amount: string; currencyId: string; decimals: number } | null {
  return amount === null ? null : { amount: amount.toString(), currencyId: USDC_ID, decimals: USDC?.decimals ?? 6 }
}

function collectionDto(collection: CollectionRow): CollectionDto {
  return {
    ref: ARC_MARKETPLACE_REF,
    id: collection.address,
    name: collection.name,
    description: `Arc marketplace collection ${collection.symbol}`,
    contractAddress: collection.address,
    verified: collection.verified,
  }
}

function nftDto(row: { collection: string; token_id: string; owner: string }): NftDto {
  return {
    ref: ARC_MARKETPLACE_REF,
    collectionId: row.collection,
    tokenId: row.token_id,
    owner: row.owner,
  }
}

/**
 * Read compatibility layer over the existing Arc SQLite projections. It performs no writes,
 * execution, or risk-gate bypass. Missing Arc projections return empty/null read results.
 */
export class ArcReadAdapter implements MarketplaceReadAdapter {
  readonly ref = ARC_MARKETPLACE_REF
  readonly capabilities = ARC_MARKETPLACE_CAPABILITIES

  constructor(
    private readonly db: Db,
    private readonly getSettings: () => Settings = defaultSettings,
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async listCollections(query: CollectionQuery = {}): Promise<Page<CollectionDto>> {
    this.assertArcChain(query.chain?.id)
    let rows = listCollections(this.db)
    if (query.creator) rows = rows.filter((x) => x.creator.toLowerCase() === query.creator!.toLowerCase())
    if (query.orderBy === 'createdAt') rows.reverse()
    return page(rows.map(collectionDto), query)
  }

  async getCollection(id: string): Promise<CollectionDto | null> {
    const collection = getCollection(this.db, id)
    return collection ? collectionDto(collection) : null
  }

  async getCollectionStats(id: string): Promise<CollectionStatsDto> {
    const collection = getCollection(this.db, id)
    if (!collection) throw new Error(`Unknown Arc collection: ${id}`)
    const stats = collectionStats(this.db, id, this.getSettings(), this.nowSec())
    return {
      floorPrice: money(stats.floor),
      volume: money(stats.volume),
      averagePrice: money(stats.medianPrice),
      totalSupply: collection.totalMinted,
      owners: stats.holders,
      sales: stats.salesCount,
      observedAt: stats.lastSaleTs === null ? undefined : new Date(stats.lastSaleTs * 1000).toISOString(),
    }
  }

  async getFloorHistory(_id: string, query: PageQuery = {}): Promise<Page<FloorPointDto>> {
    // The Arc projection stores current floor and sales, not a floor time series.
    return page([], query)
  }

  async listNfts(query: NftQuery): Promise<Page<NftDto>> {
    this.assertArcChain(query.chain?.id)
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (query.collectionId) { clauses.push('collection = ?'); params.push(query.collectionId.toLowerCase()) }
    if (query.contractAddress) {
      if (!ADDRESS.test(query.contractAddress)) throw new Error('Invalid contract address')
      clauses.push('collection = ?'); params.push(query.contractAddress.toLowerCase())
    }
    if (query.owner) { clauses.push('owner = ?'); params.push(query.owner.toLowerCase()) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.query(`SELECT collection, token_id, owner FROM tokens ${where} ORDER BY collection, token_id`).all(...params) as Array<{
      collection: string; token_id: string; owner: string
    }>
    return page(rows.map(nftDto), query)
  }

  async getNft(collectionId: string, tokenId: string): Promise<NftDto | null> {
    const row = this.db.query('SELECT collection, token_id, owner FROM tokens WHERE collection = ? AND token_id = ?')
      .get(collectionId.toLowerCase(), tokenId) as { collection: string; token_id: string; owner: string } | null
    return row ? nftDto(row) : null
  }

  async listListings(query: ListingQuery): Promise<Page<ListingDto>> {
    this.assertArcChain(query.ref?.chain.id)
    const now = this.nowSec()
    let listings = activeListings(this.db, now, query.collectionId)
    if (query.contractAddress) {
      if (!ADDRESS.test(query.contractAddress)) throw new Error('Invalid contract address')
      listings = listings.filter((x) => x.collection.toLowerCase() === query.contractAddress!.toLowerCase())
    }
    if (query.tokenId) listings = listings.filter((x) => x.tokenId === query.tokenId)
    if (query.maker) listings = listings.filter((x) => x.seller.toLowerCase() === query.maker!.toLowerCase())
    const rows: ListingDto[] = listings.map((listing) => ({
      ref: ARC_MARKETPLACE_REF,
      id: `${listing.collection}:${listing.tokenId}`,
      collectionId: listing.collection,
      contractAddress: listing.collection,
      tokenId: listing.tokenId,
      maker: listing.seller,
      price: { amount: listing.price.toString(), currencyId: USDC_ID, decimals: USDC?.decimals ?? 6 },
      createdAt: new Date(listing.listedTs * 1000).toISOString(),
      expiresAt: listing.expiry === 0 ? undefined : new Date(listing.expiry * 1000).toISOString(),
      status: 'active',
    }))
    rows.sort((a, b) => a.id.localeCompare(b.id))
    return page(rows, query)
  }

  async search(query: SearchQuery): Promise<Page<SearchResultDto>> {
    this.assertArcChain(query.chains?.[0]?.id)
    const needle = query.query.trim().toLowerCase()
    if (!needle) throw new Error('Search query must not be empty')
    const types = query.assetTypes
    const results: SearchResultDto[] = []
    if (!types || types.includes('collection')) {
      for (const item of listCollections(this.db)) {
        if (`${item.name} ${item.symbol} ${item.address}`.toLowerCase().includes(needle)) {
          results.push({ type: 'collection', id: item.address, name: item.name, ref: this.ref })
        }
      }
    }
    if (!types || types.includes('nft')) {
      const rows = this.db.query('SELECT collection, token_id FROM tokens WHERE token_id LIKE ? ORDER BY collection, token_id LIMIT 100')
        .all(`%${needle}%`) as Array<{ collection: string; token_id: string }>
      for (const row of rows) results.push({ type: 'nft', id: `${row.collection}:${row.token_id}`, name: `#${row.token_id}`, ref: this.ref })
    }
    return page(results, query)
  }

  async getRankings(query: RankingQuery): Promise<Page<CollectionDto>> {
    this.assertArcChain(query.chain?.id)
    const settings = this.getSettings()
    const now = this.nowSec()
    const rows = listCollections(this.db).map((collection) => ({
      collection,
      stats: collectionStats(this.db, collection.address, settings, now),
    }))
    if (query.orderBy === 'floorPrice') {
      rows.sort((a, b) => compareNullableBigInt(a.stats.floor, b.stats.floor))
    } else {
      rows.sort((a, b) => compareNullableBigInt(b.stats.volume, a.stats.volume))
    }
    return page(rows.map(({ collection }) => collectionDto(collection)), query)
  }

  async getActivity(query: ActivityQuery): Promise<Page<import('../../events/normalized').NormalizedMarketplaceEvent>> {
    this.assertArcChain(query.chain?.id)
    const events = readArcActivity(this.db, {
      collectionId: query.collectionId,
      eventTypes: query.eventTypes,
      after: query.after,
      before: query.before,
      nowSec: this.nowSec(),
    })
    return page(events, query)
  }

  private assertArcChain(chainId?: string): void {
    if (chainId && chainId !== this.ref.chain.id) throw new Error(`ArcReadAdapter cannot read chain ${chainId}`)
  }
}

function compareNullableBigInt(a: bigint | null, b: bigint | null): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return a < b ? -1 : a > b ? 1 : 0
}
