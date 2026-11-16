/** USDC allowance management for the market: approve once, up to the exposure cap, via the allowlisted path. */
import { agentAddress } from '../analysis/market'
import { readUsdcAllowance } from '../chain/verify'
import type { Action } from '../types'
import { buildRisk, type Ctx } from './ctx'

/**
 * Returns true when the market may already pull `needed` USDC from the agent wallet.
 * Otherwise submits an approval (subject to the usual approval flow) and returns false.
 * Paper mode has nothing to approve.
 */
export async function ensureUsdcAllowance(ctx: Ctx, needed: bigint, strategy: 'buy' | 'offers'): Promise<boolean> {
  if (ctx.own.paper() || !ctx.env.market) return true
  const agent = agentAddress(ctx.db)
  if (!agent) return false
  const allowance = await readUsdcAllowance(ctx.client, agent as `0x${string}`, ctx.env.market)
  if (allowance >= needed) return true
  const cap = ctx.getSettings().risk.maxExposurePerCollection
  const approve: Action = {
    key: `approveUsdc:market:${cap}:${allowance === 0n ? 'initial' : 'topup'}`,
    kind: 'approveUsdc',
    strategy,
    params: { spender: ctx.env.market, amount: cap.toString() },
    spend: 0n,
    gasEstimate: ctx.gas.costUsdc('approveUsdc'),
    summary: `Approve the market to spend up to ${(Number(cap) / 1e6).toFixed(3)} USDC from the agent wallet`,
  }
  await ctx.exec.submit(approve, await buildRisk(ctx, approve))
  return false
}
