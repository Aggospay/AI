import type { MockCollection, MockListing, MockNetworkId, MockNft, MockOrder } from './models'

export interface MarketplaceRepository {
  listNetworks(): MockNetworkId[]
  listListings(chain: MockNetworkId): MockListing[]
  getCollection(chain: MockNetworkId, slug: string): MockCollection | null
  listCollections(chain: MockNetworkId): MockCollection[]
  getNft(chain: MockNetworkId, contractAddress: string, tokenId: string): MockNft | null
  listNfts(chain: MockNetworkId): MockNft[]
  listOrders(chain: MockNetworkId): MockOrder[]
  insertOrder(order: MockOrder): void
}

const DEMO_OWNER = '0x00000000000000000000000000000000000000a1'
const DEMO_MAKER = '0x00000000000000000000000000000000000000b2'
const DEMO_CONTRACT = '0x0000000000000000000000000000000000000abc'
const OTHER_CONTRACT = '0x0000000000000000000000000000000000000def'

/** Deterministic fixtures; each supported mock network gets its own isolated inventory. */
export class InMemoryMarketplaceRepository implements MarketplaceRepository {
  private readonly networks: MockNetworkId[]
  private readonly collections = new Map<string, MockCollection[]>()
  private readonly nfts = new Map<string, MockNft[]>()
  private readonly listings = new Map<string, MockListing[]>()
  private readonly orders = new Map<string, MockOrder[]>()

  constructor(networks: MockNetworkId[] = ['ethereum', 'base', 'polygon', 'arbitrum', 'optimism', 'avalanche', 'zora', 'arc-testnet']) {
    this.networks = [...new Set(networks)]
    for (const chain of this.networks) this.seedNetwork(chain)
  }

  listNetworks(): MockNetworkId[] { return [...this.networks] }
  listListings(chain: MockNetworkId): MockListing[] { return [...(this.listings.get(chain) ?? [])] }
  getCollection(chain: MockNetworkId, slug: string): MockCollection | null {
    return this.listCollections(chain).find((c) => c.slug === slug) ?? null
  }
  listCollections(chain: MockNetworkId): MockCollection[] { return [...(this.collections.get(chain) ?? [])] }
  getNft(chain: MockNetworkId, contractAddress: string, tokenId: string): MockNft | null {
    return this.listNfts(chain).find((n) => n.contractAddress.toLowerCase() === contractAddress.toLowerCase() && n.tokenId === tokenId) ?? null
  }
  listNfts(chain: MockNetworkId): MockNft[] { return [...(this.nfts.get(chain) ?? [])] }
  listOrders(chain: MockNetworkId): MockOrder[] { return [...(this.orders.get(chain) ?? [])] }
  insertOrder(order: MockOrder): void {
    if (!this.networks.includes(order.chain)) throw new Error(`Unknown mock network: ${order.chain}`)
    this.orders.set(order.chain, [order, ...(this.orders.get(order.chain) ?? [])])
  }

  private seedNetwork(chain: MockNetworkId): void {
    const now = Date.now()
    const iso = (offset: number) => new Date(now - offset).toISOString()
    const collections: MockCollection[] = [
      {
        chain, slug: 'mock-creatures', name: 'Mock Creatures', description: 'Deterministic sample collection for mock marketplace development.',
        imageUrl: 'https://example.invalid/mock-creatures.png', externalUrl: 'https://example.invalid/mock-creatures',
        contractAddress: DEMO_CONTRACT, tokenStandard: 'ERC721', totalSupply: 10,
        floorPrice: { quantity: '0.42', unit: 'ETH' }, createdAt: iso(30 * 86_400_000),
      },
      {
        chain, slug: 'mock-art', name: 'Mock Art', description: 'A second isolated sample collection.',
        imageUrl: 'https://example.invalid/mock-art.png', externalUrl: 'https://example.invalid/mock-art',
        contractAddress: OTHER_CONTRACT, tokenStandard: 'ERC721', totalSupply: 4,
        floorPrice: { quantity: '125', unit: 'USDC' }, createdAt: iso(12 * 86_400_000),
      },
    ]
    const nfts: MockNft[] = Array.from({ length: 10 }, (_, index) => {
      const tokenId = String(index + 1)
      return {
        chain, contractAddress: DEMO_CONTRACT, tokenId, collectionSlug: 'mock-creatures', owner: DEMO_OWNER,
        updatedAt: iso(index * 3_600_000),
        metadata: {
          name: `Mock Creature #${tokenId}`, description: 'Synthetic metadata; not fetched from a chain or marketplace.',
          imageUrl: `https://example.invalid/mock-creatures/${tokenId}.png`,
          externalUrl: `https://example.invalid/mock-creatures/${tokenId}`,
          attributes: [{ traitType: 'Background', value: index % 2 ? 'Night' : 'Day' }, { traitType: 'Rarity', value: index < 2 ? 'Rare' : 'Common' }],
        },
      }
    })
    nfts.push({
      chain, contractAddress: OTHER_CONTRACT, tokenId: '1', collectionSlug: 'mock-art', owner: DEMO_MAKER, updatedAt: iso(1000),
      metadata: { name: 'Mock Canvas #1', description: 'Synthetic sample NFT.', imageUrl: 'https://example.invalid/mock-art/1.png', attributes: [{ traitType: 'Medium', value: 'Digital' }] },
    })
    const listings: MockListing[] = nfts.slice(0, 8).map((nft, index) => ({
      id: `mock-listing-${chain}-${index + 1}`, chain, collectionSlug: nft.collectionSlug, contractAddress: nft.contractAddress,
      tokenId: nft.tokenId, maker: index % 2 ? DEMO_MAKER : DEMO_OWNER,
      price: { quantity: (0.25 + index * 0.1).toFixed(2), unit: 'ETH' },
      createdAt: iso(index * 600_000), expiresAt: new Date(now + (index + 1) * 86_400_000).toISOString(), status: 'active', nft,
    }))
    const orders: MockOrder[] = [{
      orderHash: `mock-order-${chain}-offer-1`, chain, side: 'offer', collectionSlug: 'mock-creatures', contractAddress: DEMO_CONTRACT,
      tokenId: null, maker: DEMO_MAKER, price: { quantity: '0.30', unit: 'ETH' }, createdAt: iso(120_000), status: 'active',
    }]
    this.collections.set(chain, collections)
    this.nfts.set(chain, nfts)
    this.listings.set(chain, listings)
    this.orders.set(chain, orders)
  }
}
