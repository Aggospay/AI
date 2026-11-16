/** Shared action and intent types. Keep this the single vocabulary between strategies and execution. */

export type ActionKind =
  | 'mint'
  | 'buy'
  | 'list'
  | 'updateListing'
  | 'cancelListing'
  | 'makeOffer'
  | 'updateOffer'
  | 'cancelOffer'
  | 'acceptOffer'
  | 'approveCollection'
  | 'approveUsdc'

export type StrategyName = 'mint' | 'buy' | 'list' | 'offers' | 'portfolio' | 'system'

export type IntentStatus =
  | 'proposed' // waiting for manual approval
  | 'approved' // cleared to run
  | 'pending' // claimed by the executor
  | 'submitted' // signed and sent (live) or filled (paper)
  | 'confirmed'
  | 'failed'
  | 'rejected'
  | 'expired'

export const TERMINAL_INTENT_STATUSES: readonly IntentStatus[] = ['confirmed', 'failed', 'rejected', 'expired']

/** A fully specified onchain action. Params are strings/booleans only (bigint as decimal strings). */
export interface Action {
  /** Idempotency key: same logical action -> same key, so duplicates collapse. */
  key: string
  kind: ActionKind
  strategy: StrategyName
  collection?: string
  tokenId?: string
  params: Record<string, string | boolean>
  /** USDC (base units) that counts as acquisition spend if this action runs. */
  spend: bigint
  /** Estimated gas in USDC base units. */
  gasEstimate: bigint
  summary: string
  /** Free-form evidence persisted with the intent for the dashboard (profit analysis etc.). */
  analysis?: unknown
}

export interface IntentRow {
  key: string
  kind: ActionKind
  strategy: StrategyName
  params: Record<string, string | boolean>
  status: IntentStatus
  mode: 'paper' | 'testnet-live'
  summary: string
  analysis: unknown
  estCost: bigint
  circleTxId: string | null
  txHash: string | null
  error: string | null
  attempts: number
  createdTs: number
  updatedTs: number
  expiresTs: number | null
  collection?: string
  tokenId?: string
  spend: bigint
}

export interface Violation {
  code: string
  message: string
}
