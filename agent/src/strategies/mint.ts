/**
 * Mint sniper. Event-driven: runs on every new head and on a short timer.
 *  - Before a mint opens it prepares: contract verified, score computed, USDC allowance to the collection in place.
 *  - When the window opens it submits exactly one mint (unique intent key per collection and wallet count; the
 *    contract's own per-wallet cap is the second line of defence against duplicates).
 *  - It mints automatically only with evidence of resale value (independent secondary prices). A brand-new
 *    collection has none, so the agent records the candidate and leaves the decision to the operator.
 * Gas timing note: submission goes through Circle's API, so latency is bounded by that round trip, not by block time.
 */
import { feesFor } from '../analysis/fees'
import { agentAddress, collectionStats, getCollection, type CollectionRow } from '../analysis/market'
import { evaluateTrade } from '../analysis/profit'
import { scoreCollection } from '../analysis/scoring'
import { logActivity } from '../db'
import { collectionAbi } from '../abis'
import { readUsdcAllowance } from '../chain/verify'
import { kvGet, kvSet } from '../db'
import type { Action } from '../types'
import { errMessage, lc, nowSec } from '../util'
import { shortName } from './buyer'
import { buildRisk, eligibleCollections, type Ctx } from './ctx'
import { realisticResale, sellSideGas } from './pricing'

export type MintPhase = 'upcoming' | 'live' | 'closed' | 'soldout'

export function mintPhase(c: CollectionRow, now: number): MintPhase {
  if (c.revealed || now >= c.mintEnd) return 'closed'
  if (c.totalMinted >= c.maxSupply) return 'soldout'
  return now < c.mintStart ? 'upcoming' : 'live'
}

async function agentMintCount(ctx: Ctx, c: CollectionRow, agent: string): Promise<number> {
  if (ctx.own.paper()) {
    const r = ctx.db.query("SELECT COUNT(*) AS n FROM positions WHERE collection = ? AND source = 'mint' AND paper = 1").get(c.address) as { n: number }
    return r.n
  }
  const n = await ctx.client.readContract({
    address: c.address as `0x${string}`, abi: collectionAbi, functionName: 'mintedBy', args: [agent as `0x${string}`],
  })
  return Number(n)
}

export async function buildMintAction(ctx: Ctx, c: CollectionRow, quantity: number, minted: number) {
  const s = ctx.getSettings()
  const now = nowSec()
  const stats = collectionStats(ctx.db, c.address, s, now)
  const tokens = ctx.db.query('SELECT COUNT(*) AS n FROM tokens WHERE collection = ? AND traits IS NOT NULL').get(c.address) as { n: number }
  const score = scoreCollection(c, stats, tokens.n)
  const gasMint = ctx.gas.costUsdc('mint')
  const reference = stats.confidence >= 0.3 ? stats.fairValue : null
  const resale = reference === null ? null : realisticResale(reference, stats.floor, s.pricing.undercutTicks)
  const profit =
    resale === null
      ? null
      : evaluateTrade({
          costs: { acquisitionPrice: c.mintPrice, gasAcquire: gasMint / BigInt(quantity), gasSell: sellSideGas(ctx), other: s.risk.otherCostsPerTrade },
          fees: feesFor(ctx.db, c.address), expectedResalePrice: resale, haircutBps: BigInt(s.pricing.resaleHaircutBps),
          expectedHoldingSec: s.pricing.expectedHoldingSec, minNetProfit: s.risk.minNetProfit, minRoiBps: BigInt(s.risk.minRoiBps),
        })
  const action: Action = {
    key: `mint:${c.address}:${minted}`,
    kind: 'mint', strategy: 'mint', collection: c.address,
    params: { collection: c.address, quantity: String(quantity) },
    spend: c.mintPrice * BigInt(quantity), gasEstimate: gasMint,
    summary: `Mint ${quantity} from ${shortName(ctx, c.address)} at ${(Number(c.mintPrice) / 1e6).toFixed(3)} USDC each`,
    analysis: profit ? { netProfit: profit.netProfit, roiBps: profit.roiBps, expectedResale: resale, score: score.score } : { score: score.score, note: 'no secondary reference' },
  }
  const risk = await buildRisk(ctx, action, {
    collection: c, stats, score, gasCost: gasMint, unitPrice: c.mintPrice,
    analysis: profit ? { ok: profit.ok, netProfit: profit.netProfit, roiBps: profit.roiBps, reasons: profit.reasons } : null,
  })
  return { action, risk, profit, score }
}

export async function runMint(ctx: Ctx): Promise<void> {
  const s = ctx.getSettings()
  if (s.paused || !s.strategies.mint) return
  const agent = agentAddress(ctx.db)
  if (!agent) return
  const now = nowSec()
  for (const c of eligibleCollections(ctx)) {
    const phase = mintPhase(c, now)
    if (phase === 'closed' || phase === 'soldout') continue
    const leadSec = c.mintStart - now
    if (phase === 'upcoming' && leadSec > 300) continue
    const qty = s.mint.quantity
    const minted = await agentMintCount(ctx, c, agent)
    if (minted + qty > c.maxPerWallet) continue

    // Preparation: the collection must be able to pull the mint price when the window opens.
    if (!ctx.own.paper()) {
      const needed = c.mintPrice * BigInt(qty)
      if (needed > 0n) {
        try {
          const allowance = await readUsdcAllowance(ctx.client, agent as `0x${string}`, c.address as `0x${string}`)
          if (allowance < needed) {
            const approve: Action = {
              key: `approveUsdc:${c.address}:${needed}`, kind: 'approveUsdc', strategy: 'mint', collection: c.address,
              params: { spender: c.address, amount: needed.toString() }, spend: 0n, gasEstimate: ctx.gas.costUsdc('approveUsdc'),
              summary: `Pre-approve ${(Number(needed) / 1e6).toFixed(3)} USDC for the ${shortName(ctx, c.address)} mint`,
            }
            await ctx.exec.submit(approve, await buildRisk(ctx, approve))
            continue
          }
        } catch (e) {
          logActivity(ctx.db, { strategy: 'mint', level: 'warn', message: `Allowance check failed: ${errMessage(e)}` })
          continue
        }
      }
    }
    if (phase !== 'live') continue

    const { action, risk, profit } = await buildMintAction(ctx, c, qty, minted)
    if (!profit) {
      const seen = kvGet<Record<string, number>>(ctx.db, 'mint.candidatesSeen', {})
      if (!seen[c.address]) {
        seen[c.address] = now
        kvSet(ctx.db, 'mint.candidatesSeen', seen)
        logActivity(ctx.db, {
          strategy: 'mint',
          message: `Mint is live for ${shortName(ctx, c.address)} but there is no independent resale reference, so it was not minted automatically. Use "Mint now" to review it manually.`,
          data: { collection: c.address },
        })
      }
      continue
    }
    await ctx.exec.submit(action, risk)
  }
}

/** Operator-initiated mint: hard limits still apply, evidence gates may be waived, always needs approval. */
export async function operatorMint(ctx: Ctx, collection: string, quantity: number) {
  const c = getCollection(ctx.db, collection)
  if (!c) return { ok: false as const, error: 'unknown collection' }
  const agent = agentAddress(ctx.db)
  if (!agent) return { ok: false as const, error: 'agent wallet is not registered' }
  const now = nowSec()
  if (mintPhase(c, now) !== 'live') return { ok: false as const, error: 'mint window is not open' }
  const minted = await agentMintCount(ctx, c, agent)
  if (minted + quantity > c.maxPerWallet) return { ok: false as const, error: 'per-wallet cap reached' }
  const { action, risk } = await buildMintAction(ctx, c, quantity, minted)
  action.key = `mint:${lc(collection)}:${minted}:operator`
  const res = await ctx.exec.submit(action, risk, { operatorOverride: true })
  return { ok: res.status === 'proposed' || res.status === 'running', status: res.status, violations: res.violations, intent: res.intent }
}
