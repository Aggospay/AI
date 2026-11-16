/**
 * Deterministic collection score, 0-100. Weights follow the product spec:
 * team 15, community 15, demand 20, liquidity 15, rarity 10, mint economics 15, security 10.
 * Team and community have no data source in this build, so they are reported as "unscored"
 * and the score is normalised over the components that do have evidence. A coverage figure
 * says how much of the 100 points could actually be assessed; the risk gate requires a minimum.
 */
import type { CollectionRow, CollectionStats } from './market'

export interface ScoreComponent {
  name: string
  max: number
  /** null = unscored (no data source or no evidence available to assess). */
  points: number | null
  note: string
}

export interface CollectionScore {
  collection: string
  /** Normalised over scored components (0-100). */
  score: number
  /** Raw points / 100 across scored components. */
  rawPoints: number
  /** Share of the 100 points that could be assessed (0-1). */
  coverage: number
  components: ScoreComponent[]
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function scoreCollection(c: CollectionRow, s: CollectionStats, tokenCountWithTraits: number): CollectionScore {
  const components: ScoreComponent[] = []

  components.push({
    name: 'Team credibility', max: 15, points: null,
    note: 'No data source connected (no social or creator-history feed). Not scored.',
  })
  components.push({
    name: 'Community quality', max: 15, points: null,
    note: 'No data source connected (no social feed). Not scored.',
  })

  // Demand: independent sales velocity, breadth of buyers, and floor held above mint price.
  {
    const velocity = clamp(s.salesCount / 5, 0, 1) * 8
    const breadth = clamp(s.uniqueBuyers / 5, 0, 1) * 6
    let floorPts = 0
    if (s.floor !== null && c.mintPrice > 0n) {
      const ratio = Number((s.floor * 1000n) / c.mintPrice) / 1000
      floorPts = ratio >= 1 ? 6 : ratio >= 0.8 ? 3 : 0
    } else if (s.floor !== null) {
      floorPts = 3
    }
    components.push({
      name: 'Market demand', max: 20, points: round1(velocity + breadth + floorPts),
      note: `${s.salesCount} independent sales, ${s.uniqueBuyers} unique buyers in window`,
    })
  }

  // Liquidity: listing depth, holder spread, whale concentration.
  {
    const depth = clamp(s.activeListings / 5, 0, 1) * 4
    const spread = clamp(s.holders / 10, 0, 1) * 4
    const conc = s.holders === 0 ? 0 : s.topHolderShareBps <= 2500 ? 4 : s.topHolderShareBps <= 5000 ? 2 : 0
    const balance = s.uniqueSellers > 0 && s.uniqueBuyers > 0 ? 3 : 0
    components.push({
      name: 'Liquidity potential', max: 15, points: round1(depth + spread + conc + balance),
      note: `${s.activeListings} listings, ${s.holders} holders, top holder ${(s.topHolderShareBps / 100).toFixed(1)}%`,
    })
  }

  // Rarity: only assessable after reveal.
  if (c.revealed && tokenCountWithTraits > 0) {
    const coverageOfSupply = clamp(tokenCountWithTraits / Math.max(1, c.totalMinted), 0, 1)
    components.push({
      name: 'Rarity and uniqueness', max: 10, points: round1(6 + 4 * coverageOfSupply),
      note: `Traits revealed for ${tokenCountWithTraits} tokens (deterministic weighted traits)`,
    })
  } else {
    components.push({
      name: 'Rarity and uniqueness', max: 10, points: null,
      note: c.revealed ? 'Revealed, traits not yet read' : 'Traits are hidden until reveal. Not scored.',
    })
  }

  // Mint economics: price vs observed value, scarcity, per-wallet cap.
  {
    let pricePts: number | null = null
    if (s.fairValue !== null && s.confidence >= 0.3 && c.mintPrice > 0n) {
      const ratio = Number((c.mintPrice * 1000n) / s.fairValue) / 1000
      pricePts = ratio <= 0.7 ? 8 : ratio <= 1 ? 5 : ratio <= 1.2 ? 2 : 0
    } else if (c.mintPrice === 0n) pricePts = 2
    const scarcity = c.maxSupply <= 1000 ? 3 : c.maxSupply <= 5000 ? 2 : c.maxSupply <= 10000 ? 1 : 0
    const capShare = c.maxPerWallet / Math.max(1, c.maxSupply)
    const cap = capShare <= 0.05 ? 2 : capShare <= 0.2 ? 1 : 0
    const base = scarcity + cap
    components.push({
      name: 'Mint economics', max: 15,
      points: pricePts === null ? null : round1(pricePts + base),
      note: pricePts === null
        ? 'No reliable secondary value to compare the mint price against. Not scored.'
        : `Mint price vs fair value, supply ${c.maxSupply}, wallet cap ${c.maxPerWallet}`,
    })
  }

  // Contract and security: factory-registered immutable ArcCollection, bounded royalty, commit-reveal.
  {
    const verified = c.verified ? 6 : 0
    const royalty = c.royaltyBps <= 1000 ? 2 : 0
    components.push({
      name: 'Contract and security', max: 10, points: verified + royalty + 2,
      note: c.verified
        ? 'Factory-deployed immutable collection (no owner, no admin, no upgrade path), commit-reveal traits'
        : 'Not created by the trusted factory',
    })
  }

  const scored = components.filter((x) => x.points !== null)
  const maxScored = scored.reduce((sum, x) => sum + x.max, 0)
  const pts = scored.reduce((sum, x) => sum + (x.points ?? 0), 0)
  return {
    collection: c.address,
    score: maxScored > 0 ? round1((pts / maxScored) * 100) : 0,
    rawPoints: round1(pts),
    coverage: maxScored / 100,
    components,
  }
}

export function passesScoreGate(score: CollectionScore, minScore: number, minCoverage: number): boolean {
  return score.score >= minScore && score.coverage >= minCoverage
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
