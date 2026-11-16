/**
 * Live onchain checks used right before acting, so decisions never rest on an index that could be
 * stale or manipulated: the current listing, token owner, approvals and allowances.
 */
import { collectionAbi, erc20Abi, marketAbi } from '../abis'
import { USDC_ADDRESS, type Client } from './clients'

export interface LiveListing {
  seller: string
  price: bigint
  expiry: number
  ownerIsSeller: boolean
  approved: boolean
}

export async function readLiveListing(
  client: Client, market: `0x${string}`, collection: `0x${string}`, tokenId: bigint,
): Promise<LiveListing | null> {
  const listing = await client.readContract({
    address: market, abi: marketAbi, functionName: 'getListing', args: [collection, tokenId],
  })
  if (listing.price === 0n) return null
  const [owner, approvedFor, approvedAll] = await Promise.all([
    client.readContract({ address: collection, abi: collectionAbi, functionName: 'ownerOf', args: [tokenId] }),
    client.readContract({ address: collection, abi: collectionAbi, functionName: 'getApproved', args: [tokenId] }),
    client.readContract({
      address: collection, abi: collectionAbi, functionName: 'isApprovedForAll', args: [listing.seller, market],
    }),
  ])
  return {
    seller: listing.seller.toLowerCase(),
    price: listing.price,
    expiry: Number(listing.expiry),
    ownerIsSeller: owner.toLowerCase() === listing.seller.toLowerCase(),
    approved: approvedAll || approvedFor.toLowerCase() === market.toLowerCase(),
  }
}

export async function readUsdcAllowance(client: Client, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  return client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
}

export async function readCollectionApproval(
  client: Client, collection: `0x${string}`, owner: `0x${string}`, market: `0x${string}`,
): Promise<boolean> {
  return client.readContract({
    address: collection, abi: collectionAbi, functionName: 'isApprovedForAll', args: [owner, market],
  })
}

/** Current onchain owner of a token, or null when the call fails (caller should then do nothing). */
export async function readTokenOwner(client: Client, collection: `0x${string}`, tokenId: string): Promise<string | null> {
  try {
    const owner = await client.readContract({ address: collection, abi: collectionAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] })
    return owner.toLowerCase()
  } catch {
    return null
  }
}
