/**
 * Execution service: durable intents, idempotent execution, approval flow, recovery.
 *
 * Lifecycle: proposed (manual) -> approved -> pending -> submitted -> confirmed | failed.
 * Every transition is a compare-and-set in SQLite, so two callers can never both run an intent.
 * The risk gate runs before an intent is created; the global gate (pause, mode, expiry) runs again
 * immediately before anything is signed. Failures before a transaction id exists are retried with the
 * same idempotency key (Circle executes a key at most once); anything after that is reconciled, never resent.
 */
import { createHash } from 'node:crypto'
import type { Bus } from '../bus'
import type { EnvConfig, Settings } from '../config'
import { logActivity, type Db } from '../db'
import { logger } from '../log'
import { checkRisk, recordSpend, refundSpend, type RiskInput } from '../risk/engine'
import type { Action, IntentRow, Violation } from '../types'
import { errMessage, nowMs } from '../util'
import { getIntent, insertIntent, listIntents, transition } from './intents'
import { PolicyError, prepareCall, type PreparedCall } from './policy'
import type { GasOracle } from './gas'

const log = logger('exec')

export interface TrackResult {
  ok: boolean
  txHash?: string
  gasUsed?: bigint
  /** Effective gas cost in USDC base units when known. */
  gasCostUsdc?: bigint
  error?: string
}

export interface Executor {
  readonly mode: 'paper' | 'testnet-live'
  submit(intent: IntentRow, call: PreparedCall): Promise<{ circleTxId?: string }>
  track(intent: IntentRow): Promise<TrackResult>
}

export interface SubmitResult {
  status: 'blocked' | 'duplicate' | 'proposed' | 'running' | 'rejected'
  intent?: IntentRow
  violations: Violation[]
}

/** Deterministic UUID-shaped idempotency key derived from the intent key. */
export function uuidFromKey(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  const variant = ((parseInt(h.slice(16, 17), 16) & 3) | 8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const SAFE_AUTO = new Set(['cancelOffer', 'cancelListing'])
/** Emergency cancellations issued by the system itself must still go through while the global pause is on. */
const isEmergencyCancel = (kind: string, strategy: string): boolean => SAFE_AUTO.has(kind) && strategy === 'system'
const WAIVABLE_FOR_OPERATOR_MINT = new Set([
  'illiquid', 'no-market-data', 'unprofitable', 'no-analysis', 'score-below-threshold', 'no-score',
])
const RETRY_AFTER_FAILED_MS = 60_000
const MAX_SUBMIT_ATTEMPTS = 3

export class ExecutionService {
  private running = new Set<string>()
  private blockedLog = new Map<string, number>()

  constructor(
    private db: Db,
    private env: EnvConfig,
    private bus: Bus,
    private getSettings: () => Settings,
    private executors: { paper: Executor; live: () => Executor | null },
    private gas: GasOracle,
    private hooks: { onConfirmed?: (intent: IntentRow) => void } = {},
  ) {}

  /** Risk-check an action and either create an intent or explain why not. */
  submit(action: Action, risk: RiskInput | null, opts: { operatorOverride?: boolean } = {}): Promise<SubmitResult> {
    return Promise.resolve(this.submitSync(action, risk, opts))
  }

  private submitSync(action: Action, risk: RiskInput | null, opts: { operatorOverride?: boolean }): SubmitResult {
    const settings = this.getSettings()
    if (settings.paused && !isEmergencyCancel(action.kind, action.strategy)) return { status: 'blocked', violations: [{ code: 'paused', message: 'The global pause switch is on' }] }

    const existing = getIntent(this.db, action.key)
    if (existing) {
      const retryable =
        (existing.status === 'failed' || existing.status === 'expired' || existing.status === 'rejected') &&
        nowMs() - existing.updatedTs > RETRY_AFTER_FAILED_MS
      if (!retryable) return { status: 'duplicate', intent: existing, violations: [] }
      this.db.query('DELETE FROM intents WHERE key = ?').run(action.key)
    }

    let violations = risk ? checkRisk(risk) : []
    // Operator-initiated mints may waive evidence gates (no secondary market exists for a brand-new
    // collection) but never hard limits, and are always held for explicit approval.
    const overridden = opts.operatorOverride === true && action.kind === 'mint'
    if (overridden) violations = violations.filter((v) => !WAIVABLE_FOR_OPERATOR_MINT.has(v.code))
    if (violations.length > 0) {
      this.noteBlocked(action, violations)
      return { status: 'blocked', violations }
    }

    const manual = overridden || (settings.approvalMode === 'manual' && !SAFE_AUTO.has(action.kind))
    const expires = manual ? nowMs() + settings.proposals.ttlSec * 1000 : null
    if (!insertIntent(this.db, action, manual ? 'proposed' : 'approved', settings.mode, expires)) {
      return { status: 'duplicate', intent: getIntent(this.db, action.key) ?? undefined, violations: [] }
    }
    const intent = getIntent(this.db, action.key) as IntentRow
    logActivity(this.db, {
      strategy: action.strategy,
      message: manual ? `Proposed: ${action.summary}` : `Approved automatically: ${action.summary}`,
      data: { key: action.key, kind: action.kind },
    })
    this.bus.emit('intent:updated', intent)
    if (manual) return { status: 'proposed', intent, violations: [] }
    void this.run(action.key)
    return { status: 'running', intent, violations: [] }
  }

  private noteBlocked(action: Action, violations: Violation[]): void {
    const sig = `${action.kind}:${action.collection ?? ''}:${action.tokenId ?? ''}:${violations.map((v) => v.code).join(',')}`
    const last = this.blockedLog.get(sig) ?? 0
    if (nowMs() - last < 10 * 60_000) return
    this.blockedLog.set(sig, nowMs())
    logActivity(this.db, {
      strategy: action.strategy, level: 'info',
      message: `Blocked ${action.kind}: ${violations.map((v) => v.message).join('; ')}`,
      data: { collection: action.collection, tokenId: action.tokenId, codes: violations.map((v) => v.code) },
    })
  }

  approve(key: string): { ok: boolean; error?: string } {
    const intent = getIntent(this.db, key)
    if (!intent) return { ok: false, error: 'unknown intent' }
    if (intent.status !== 'proposed') return { ok: false, error: `intent is ${intent.status}` }
    if (intent.expiresTs !== null && intent.expiresTs < nowMs()) {
      transition(this.db, key, 'proposed', 'expired')
      return { ok: false, error: 'proposal expired' }
    }
    if (this.getSettings().paused) return { ok: false, error: 'agent is paused' }
    if (intent.mode !== this.getSettings().mode) return { ok: false, error: 'mode changed since proposal' }
    if (!transition(this.db, key, 'proposed', 'approved')) return { ok: false, error: 'already handled' }
    logActivity(this.db, { strategy: intent.strategy, message: `Approved by operator: ${intent.summary}`, data: { key } })
    this.bus.emit('intent:updated', getIntent(this.db, key))
    void this.run(key)
    return { ok: true }
  }

  reject(key: string): { ok: boolean; error?: string } {
    const intent = getIntent(this.db, key)
    if (!intent) return { ok: false, error: 'unknown intent' }
    if (!transition(this.db, key, ['proposed', 'approved'], 'rejected', { error: 'rejected by operator' })) {
      return { ok: false, error: `intent is ${intent.status}` }
    }
    this.bus.emit('intent:updated', getIntent(this.db, key))
    return { ok: true }
  }

  /** Claim and execute one approved intent. Safe to call repeatedly. */
  async run(key: string): Promise<void> {
    if (this.running.has(key)) return
    this.running.add(key)
    try {
      await this.runInner(key)
    } catch (e) {
      log.error('run crashed', { key, error: errMessage(e) })
    } finally {
      this.running.delete(key)
    }
  }

  private async runInner(key: string): Promise<void> {
    const settings = this.getSettings()
    const preview = getIntent(this.db, key)
    if (!preview) return
    if (!transition(this.db, key, 'approved', 'pending', { attempts: preview.attempts })) return
    let intent = getIntent(this.db, key) as IntentRow

    const fail = (status: 'failed' | 'rejected', error: string) => {
      refundSpend(this.db, key)
      transition(this.db, key, ['pending', 'submitted'], status, { error })
      logActivity(this.db, { strategy: intent.strategy, level: status === 'failed' ? 'error' : 'warn', message: `${status === 'failed' ? 'Failed' : 'Rejected'}: ${intent.summary} (${error})`, data: { key } })
      this.bus.emit('intent:updated', getIntent(this.db, key))
    }

    if (settings.paused && !isEmergencyCancel(intent.kind, intent.strategy)) return fail('rejected', 'global pause is on')
    if (intent.mode !== settings.mode) return fail('rejected', 'mode changed before execution')
    const executor = settings.mode === 'paper' ? this.executors.paper : this.executors.live()
    if (!executor) return fail('rejected', 'live executor is not configured (missing Circle credentials or wallet)')

    let call: PreparedCall
    try {
      call = prepareCall(this.actionOf(intent), this.db, this.env, settings)
    } catch (e) {
      return fail('rejected', e instanceof PolicyError ? `policy: ${e.message}` : errMessage(e))
    }

    if (intent.spend > 0n) recordSpend(this.db, key, intent.kind, intent.spend, intent.collection)

    try {
      const sent = await executor.submit(intent, call)
      transition(this.db, key, 'pending', 'submitted', { circleTxId: sent.circleTxId ?? null })
      intent = getIntent(this.db, key) as IntentRow
      this.bus.emit('intent:updated', intent)
    } catch (e) {
      const msg = errMessage(e)
      const transient = isTransient(e)
      if (transient && intent.attempts + 1 < MAX_SUBMIT_ATTEMPTS && !intent.circleTxId) {
        // Safe to retry: nothing was accepted, and the idempotency key makes a duplicate impossible.
        transition(this.db, key, 'pending', 'approved', { attempts: intent.attempts + 1, error: msg })
        log.warn('submit failed, will retry', { key, attempt: intent.attempts + 1, error: msg })
        return
      }
      return fail('failed', msg)
    }

    const result = await executor.track(getIntent(this.db, key) as IntentRow).catch((e: unknown): TrackResult => ({
      ok: false, error: errMessage(e),
    }))
    if (!result.ok) return fail('failed', result.error ?? 'transaction did not succeed')

    transition(this.db, key, ['pending', 'submitted'], 'confirmed', { txHash: result.txHash ?? null })
    intent = getIntent(this.db, key) as IntentRow
    if (executor.mode === 'testnet-live') {
      if (result.gasUsed !== undefined) this.gas.recordActual(intent.kind, result.gasUsed)
      const gasCost = result.gasCostUsdc ?? intent.estCost
      this.db.query(
        'INSERT INTO ledger (ts, kind, collection, token_id, amount, note, intent_key, paper) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      ).run(nowMs(), 'gas', intent.collection ?? null, intent.tokenId ?? null, (-gasCost).toString(), `${intent.kind} gas`, key)
    }
    logActivity(this.db, { strategy: intent.strategy, message: `Confirmed: ${intent.summary}`, data: { key, txHash: result.txHash } })
    this.bus.emit('intent:updated', intent)
    this.hooks.onConfirmed?.(intent)
  }

  private actionOf(i: IntentRow): Action {
    return {
      key: i.key, kind: i.kind, strategy: i.strategy, collection: i.collection, tokenId: i.tokenId,
      params: i.params, spend: i.spend, gasEstimate: i.estCost, summary: i.summary,
    }
  }

  /** Resume work after a restart: expire stale proposals, re-run approved intents, re-track in-flight ones. */
  recover(): void {
    this.expireProposals()
    const settings = this.getSettings()
    for (const i of listIntents(this.db, ['pending', 'submitted'], 500)) {
      if (i.mode !== settings.mode) {
        transition(this.db, i.key, ['pending', 'submitted'], 'failed', { error: 'interrupted by restart in a different mode' })
        continue
      }
      if (i.status === 'pending' && !i.circleTxId) {
        // Never confirmed as sent. Re-run with the same idempotency key: exactly-once at the provider.
        transition(this.db, i.key, 'pending', 'approved')
        void this.run(i.key)
      } else if (i.circleTxId) {
        void this.resumeTracking(i.key)
      } else if (i.mode === 'paper') {
        transition(this.db, i.key, ['pending', 'submitted'], 'failed', { error: 'interrupted by restart' })
        refundSpend(this.db, i.key)
      }
    }
    for (const i of listIntents(this.db, ['approved'], 500)) void this.run(i.key)
  }

  private async resumeTracking(key: string): Promise<void> {
    if (this.running.has(key)) return
    this.running.add(key)
    try {
      const settings = this.getSettings()
      const intent = getIntent(this.db, key)
      const executor = settings.mode === 'paper' ? this.executors.paper : this.executors.live()
      if (!intent || !executor) return
      const result = await executor.track(intent).catch((e: unknown): TrackResult => ({ ok: false, error: errMessage(e) }))
      if (result.ok) {
        transition(this.db, key, ['pending', 'submitted'], 'confirmed', { txHash: result.txHash ?? null })
        this.hooks.onConfirmed?.(getIntent(this.db, key) as IntentRow)
      } else {
        refundSpend(this.db, key)
        transition(this.db, key, ['pending', 'submitted'], 'failed', { error: result.error ?? 'transaction did not succeed' })
      }
      this.bus.emit('intent:updated', getIntent(this.db, key))
    } finally {
      this.running.delete(key)
    }
  }

  expireProposals(): number {
    const res = this.db
      .query("UPDATE intents SET status = 'expired', updated_ts = ? WHERE status = 'proposed' AND expires_ts IS NOT NULL AND expires_ts < ?")
      .run(nowMs(), nowMs())
    return res.changes
  }

  /** Re-run approved intents that were parked for retry. */
  processApproved(): void {
    for (const i of listIntents(this.db, ['approved'], 100)) {
      const backoff = 2000 * 2 ** i.attempts
      if (nowMs() - i.updatedTs >= backoff) void this.run(i.key)
    }
  }
}

function isTransient(e: unknown): boolean {
  const anyErr = e as { response?: { status?: number }; code?: string; message?: string }
  const status = anyErr?.response?.status
  if (status === 429 || (status !== undefined && status >= 500)) return true
  const code = anyErr?.code ?? ''
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return true
  return /timeout|temporar|network|fetch failed/i.test(anyErr?.message ?? '')
}
