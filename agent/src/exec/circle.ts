/**
 * Circle developer-controlled wallet executor. The signing key never leaves Circle: this process
 * only sends allowlisted contract-execution requests (see policy.ts) and tracks them to a terminal state.
 * There is deliberately no method here for signing messages, typed data, raw transactions, or transfers.
 */
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { waitForTerminal } from '../../../src/onchain-wait'
import { gasCostUsdc } from '../analysis/profit'
import type { Client } from '../chain/clients'
import { ARC_TESTNET_CHAIN_ID } from '../config'
import type { Db } from '../db'
import type { IntentRow } from '../types'
import { errMessage } from '../util'
import type { PreparedCall } from './policy'
import { uuidFromKey, type Executor, type TrackResult } from './service'

type CircleClient = ReturnType<typeof initiateDeveloperControlledWalletsClient>

export function circleCredentialsPresent(): boolean {
  const secret = process.env.CIRCLE_ENTITY_SECRET ?? process.env.ENTITY_SECRET ?? process.env.CIRCLE_SCP_ENTITY_SECRET
  return Boolean(process.env.CIRCLE_API_KEY && secret)
}

export function makeCircleClient(): CircleClient {
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET ?? process.env.ENTITY_SECRET ?? process.env.CIRCLE_SCP_ENTITY_SECRET
  if (!process.env.CIRCLE_API_KEY || !entitySecret) throw new Error('Circle credentials are not configured')
  return initiateDeveloperControlledWalletsClient({ apiKey: process.env.CIRCLE_API_KEY, entitySecret })
}

export class CircleExecutor implements Executor {
  readonly mode = 'testnet-live' as const
  private circle: CircleClient

  constructor(
    private db: Db,
    private chain: Client,
    private walletIdFor: () => string | null,
  ) {
    this.circle = makeCircleClient()
  }

  async submit(intent: IntentRow, call: PreparedCall): Promise<{ circleTxId?: string }> {
    const walletId = this.walletIdFor()
    if (!walletId) throw new Error('agent wallet is not registered')
    const res = await this.circle.createContractExecutionTransaction({
      walletId,
      contractAddress: call.contractAddress,
      abiFunctionSignature: call.abiFunctionSignature,
      abiParameters: call.abiParameters,
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      idempotencyKey: uuidFromKey(intent.key),
      refId: intent.key.slice(0, 120),
    })
    const id = res.data?.id
    if (!id) throw new Error('Circle did not return a transaction id')
    return { circleTxId: id }
  }

  async track(intent: IntentRow): Promise<TrackResult> {
    const id = intent.circleTxId
    if (!id) return { ok: false, error: 'no Circle transaction id to track' }
    try {
      const tx = await waitForTerminal(
        () => this.circle.getTransaction({ id }),
        (r) => r.data?.transaction?.state,
        { intervalMs: 1500, timeoutMs: 180_000 },
      )
      const t = tx.data?.transaction
      if (!t || t.state !== 'COMPLETE') {
        return { ok: false, error: `Circle transaction ended in state ${t?.state ?? 'unknown'}${t?.errorReason ? ` (${t.errorReason})` : ''}` }
      }
      const txHash = t.txHash as `0x${string}` | undefined
      if (!txHash) return { ok: false, error: 'Circle reported COMPLETE without a transaction hash' }
      // Never trust the provider state alone: confirm success on chain.
      const receipt = await this.chain.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 })
      if (receipt.status !== 'success') return { ok: false, txHash, error: 'transaction reverted onchain' }
      const gasCost = gasCostUsdc(ARC_TESTNET_CHAIN_ID, receipt.gasUsed, receipt.effectiveGasPrice)
      return { ok: true, txHash, gasUsed: receipt.gasUsed, gasCostUsdc: gasCost }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  }

  /** Reads the agent wallet's registered id from the wallets table (set by the setup script). */
  static walletIdFromDb(db: Db): string | null {
    const r = db.query("SELECT circle_wallet_id FROM wallets WHERE role = 'agent' LIMIT 1").get() as {
      circle_wallet_id: string | null
    } | null
    return r?.circle_wallet_id ?? null
  }
}
