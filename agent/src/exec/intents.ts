/** Intent persistence. An intent is a durable, idempotent record of one action's lifecycle. */
import type { Db } from '../db'
import type { Action, IntentRow, IntentStatus } from '../types'
import { TERMINAL_INTENT_STATUSES } from '../types'
import { nowMs, parseJson, toJson } from '../util'

type Raw = Record<string, string | number | null>

export function toIntent(r: Raw): IntentRow {
  return {
    key: String(r.key),
    kind: String(r.kind) as IntentRow['kind'],
    strategy: String(r.strategy) as IntentRow['strategy'],
    params: parseJson(String(r.params), {}),
    status: String(r.status) as IntentStatus,
    mode: String(r.mode) as IntentRow['mode'],
    summary: String(r.summary ?? ''),
    analysis: parseJson(r.analysis == null ? null : String(r.analysis), null),
    estCost: BigInt(String(r.est_cost ?? '0')),
    circleTxId: r.circle_tx_id == null ? null : String(r.circle_tx_id),
    txHash: r.tx_hash == null ? null : String(r.tx_hash),
    error: r.error == null ? null : String(r.error),
    attempts: Number(r.attempts ?? 0),
    createdTs: Number(r.created_ts),
    updatedTs: Number(r.updated_ts),
    expiresTs: r.expires_ts == null ? null : Number(r.expires_ts),
    collection: r.collection == null ? undefined : String(r.collection),
    tokenId: r.token_id == null ? undefined : String(r.token_id),
    spend: BigInt(String(r.spend ?? '0')),
  }
}

export function getIntent(db: Db, key: string): IntentRow | null {
  const r = db.query('SELECT * FROM intents WHERE key = ?').get(key) as Raw | null
  return r ? toIntent(r) : null
}

export function listIntents(db: Db, statuses?: IntentStatus[], limit = 200): IntentRow[] {
  const rows = (
    statuses && statuses.length
      ? db
          .query(`SELECT * FROM intents WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_ts DESC LIMIT ?`)
          .all(...statuses, limit)
      : db.query('SELECT * FROM intents ORDER BY created_ts DESC LIMIT ?').all(limit)
  ) as Raw[]
  return rows.map(toIntent)
}

export function insertIntent(
  db: Db,
  action: Action,
  status: IntentStatus,
  mode: IntentRow['mode'],
  expiresTs: number | null,
): boolean {
  const now = nowMs()
  const res = db
    .query(
      `INSERT OR IGNORE INTO intents (key, kind, strategy, params, status, mode, summary, analysis, collection, token_id, spend,
        est_cost, attempts, created_ts, updated_ts, expires_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      action.key, action.kind, action.strategy, toJson(action.params), status, mode, action.summary,
      action.analysis === undefined ? null : toJson(action.analysis), action.collection ?? null, action.tokenId ?? null,
      action.spend.toString(), action.gasEstimate.toString(), now, now, expiresTs,
    )
  return res.changes > 0
}

/** Atomic compare-and-set on status. Returns true only for the caller that won the transition. */
export function transition(db: Db, key: string, from: IntentStatus | IntentStatus[], to: IntentStatus, patch: Partial<{
  error: string | null
  circleTxId: string | null
  txHash: string | null
  attempts: number
}> = {}): boolean {
  const froms = Array.isArray(from) ? from : [from]
  const res = db
    .query(
      `UPDATE intents SET status = ?, updated_ts = ?,
        error = COALESCE(?, error), circle_tx_id = COALESCE(?, circle_tx_id), tx_hash = COALESCE(?, tx_hash),
        attempts = COALESCE(?, attempts)
       WHERE key = ? AND status IN (${froms.map(() => '?').join(',')})`,
    )
    .run(to, nowMs(), patch.error ?? null, patch.circleTxId ?? null, patch.txHash ?? null, patch.attempts ?? null, key, ...froms)
  return res.changes > 0
}

export const isTerminal = (s: IntentStatus): boolean => TERMINAL_INTENT_STATUSES.includes(s)
