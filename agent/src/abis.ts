/** Human-readable ABIs for the deployed contracts. Mirrors contracts/*.sol. */
import { parseAbi } from 'viem'

export const COLLECTION_PARAMS_TUPLE =
  '(string name, string symbol, uint256 mintPrice, uint32 maxSupply, uint32 maxPerWallet, uint64 mintStart, address royaltyReceiver, uint96 royaltyBps, string baseUri, bytes32 seedCommitment, uint64 mintEnd)'

export const factoryAbi = parseAbi([
  'event FactoryConfigured(address indexed factory, address indexed usdc)',
  'event CollectionCreated(address indexed collection, address indexed creator, string name, string symbol, uint256 mintPrice, uint32 maxSupply, uint32 maxPerWallet, uint64 mintStart, uint96 royaltyBps, bytes32 seedCommitment, uint64 mintEnd)',
  `function createCollection(${COLLECTION_PARAMS_TUPLE} params) returns (address collection)`,
  'function isCollection(address) view returns (bool)',
  'function collectionCount() view returns (uint256)',
  'function collectionAt(uint256 index) view returns (address)',
  'function usdc() view returns (address)',
])

export const collectionAbi = parseAbi([
  'event Minted(address indexed minter, uint256 indexed tokenId)',
  'event Revealed(bytes32 seed, bool fallbackSeed)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'function mint(uint32 quantity)',
  'function reveal(bytes32 seed)',
  'function revealFallback()',
  'function traitsOf(uint256 tokenId) view returns (uint32)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function approve(address to, uint256 tokenId)',
  'function totalMinted() view returns (uint256)',
  'function mintedBy(address) view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function maxSupply() view returns (uint32)',
  'function maxPerWallet() view returns (uint32)',
  'function mintStart() view returns (uint64)',
  'function mintEnd() view returns (uint64)',
  'function revealed() view returns (bool)',
  'function payee() view returns (address)',
  'function usdc() view returns (address)',
  'function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)',
  'function seedCommitment() view returns (bytes32)',
])

export const marketAbi = parseAbi([
  'event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint128 price, uint64 expiry)',
  'event ListingUpdated(address indexed collection, uint256 indexed tokenId, address indexed seller, uint128 oldPrice, uint128 newPrice, uint64 newExpiry)',
  'event ListingCancelled(address indexed collection, uint256 indexed tokenId, address indexed seller, bool byAnyone)',
  'event Sale(address indexed collection, uint256 indexed tokenId, address indexed seller, address buyer, uint256 price, uint256 fee, uint256 royalty, uint8 kind)',
  'event OfferMade(uint256 indexed offerId, address indexed collection, address indexed bidder, uint256 tokenId, bool collectionWide, uint128 price, uint64 expiry)',
  'event OfferUpdated(uint256 indexed offerId, uint128 oldPrice, uint128 newPrice, uint64 newExpiry)',
  'event OfferCancelled(uint256 indexed offerId, address bidder, uint256 refund, bool expiredReclaim)',
  'event OfferAccepted(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address seller, address bidder, uint256 price)',
  'event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps)',
  'event RoyaltyWithdrawn(address indexed receiver, uint256 amount)',
  'function list(address collection, uint256 tokenId, uint256 price, uint64 expiry)',
  'function updateListing(address collection, uint256 tokenId, uint256 newPrice, uint64 newExpiry)',
  'function cancelListing(address collection, uint256 tokenId)',
  'function buy(address collection, uint256 tokenId, uint256 maxPrice)',
  'function makeOffer(address collection, uint256 tokenId, bool collectionWide, uint256 price, uint64 expiry) returns (uint256 offerId)',
  'function updateOffer(uint256 offerId, uint256 newPrice, uint64 newExpiry)',
  'function cancelOffer(uint256 offerId)',
  'function reclaimExpiredOffer(uint256 offerId)',
  'function acceptOffer(uint256 offerId, uint256 tokenId, uint256 minPrice)',
  'function acceptCollectionOffer(uint256 offerId, uint256 tokenId, uint256 minPrice)',
  'function withdrawRoyalty(address receiver)',
  'function quote(address collection, uint256 tokenId, uint256 price) view returns (uint256 fee, uint256 royalty, address royaltyReceiver, uint256 sellerProceeds)',
  'function getListing(address collection, uint256 tokenId) view returns ((address seller, uint128 price, uint64 expiry))',
  'function getOffer(uint256 offerId) view returns ((address bidder, address collection, uint256 tokenId, bool collectionWide, uint128 price, uint64 expiry))',
  'function nextOfferId() view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function feeRecipient() view returns (address)',
  'function paused() view returns (bool)',
  'function royaltyBalance(address) view returns (uint256)',
  'function usdc() view returns (address)',
  'function registry() view returns (address)',
])

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
])

/** Combined ABI for decoding every log the indexer cares about. */
export const indexedAbi = [...factoryAbi, ...collectionAbi, ...marketAbi] as const
