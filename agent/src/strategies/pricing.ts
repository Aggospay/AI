/** Shared pricing helpers: comparable competitors, realistic exit price, sell-side gas. */
import {
  activeListings, comparableListings, rarityTable, UNKNOWN_TIER, type ListingRow, type RarityInfo,
} from '../analysis/market'
import { PRICE_TICK } from '../config'
import { floorToTick, minBig } from '../util'
import type { Ctx } from './ctx'

export interface Comparables {
  rarity: Map<string, RarityInfo>
  tier: number
  /** Competitor listings that really compete with this token (own listings and this token excluded). */
  competitors: ListingRow[]
  lowest: ListingRow | null
}

export function comparablesFor(
  ctx: Ctx, collection: string, tokenId: string, now: number, agent: string | null,
): Comparables {
  const rarity = rarityTable(ctx.db, collection)
  const tier = rarity.get(tokenId)?.tier ?? UNKNOWN_TIER
  const competitors = comparableListings(activeListings(ctx.db, now, collection), rarity, tier, {
    seller: agent ?? undefined,
    tokenId,
  })
  let lowest: ListingRow | null = null
  for (const l of competitors) if (!lowest || l.price < lowest.price) lowest = l
  return { rarity, tier, competitors, lowest }
}

/**
 * The price we can realistically expect to sell at: token fair value, capped by the lowest
 * comparable competitor minus our undercut. Never above what the market currently asks.
 */
export function realisticResale(
  tokenFair: bigint | null, lowestCompetitor: bigint | null, undercutTicks: number,
): bigint | null {
  const undercut = PRICE_TICK * BigInt(undercutTicks)
  if (tokenFair === null && lowestCompetitor === null) return null
  if (lowestCompetitor === null) return floorToTick(tokenFair as bigint, PRICE_TICK)
  const cap = lowestCompetitor > undercut ? lowestCompetitor - undercut : lowestCompetitor
  return floorToTick(tokenFair === null ? cap : minBig(tokenFair, cap), PRICE_TICK)
}

/** Gas the agent still expects to pay after acquiring: approval, listing and a few reprices. */
export function sellSideGas(ctx: Ctx, needsApproval = true): bigint {
  return (
    ctx.gas.costUsdc('list') +
    (needsApproval ? ctx.gas.costUsdc('approveCollection') : 0n) +
    ctx.gas.costUsdc('updateListing', 2)
  )
}
