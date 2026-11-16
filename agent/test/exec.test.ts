import { describe, expect, test } from 'bun:test'
import { getIntent, listIntents } from '../src/exec/intents'
import { uuidFromKey, type Executor, type TrackResult } from '../src/exec/service'
import { prepareCall, PolicyError } from '../src/exec/policy'
import { spendTotals } from '../src/risk/engine'
import type { Action } from '../src/types'
import { COLL, MARKET, U, makeCtx, makeDb, seedCollection, seedListing, seedToken, settleIntents, settingsWith, testEnv } from './helpers'

function listAction(over: Partial<Action> = {}): Action {
  return {
    key: 'list:1', kind: 'cancelListing', strategy: 'list', collection: COLL, tokenId: '1',
    params: { collection: COLL, tokenId: '1' }, spend: 0n, gasEstimate: 1000n, summary: 'cancel listing', ...over,
  }
}

describe('execution service', () => {
  test('the same logical action collapses into one intent (duplicate protection)', async () => {
    const db = makeDb()
    seedCollection(db)
    const { ctx } = await makeCtx(db)
    const a = await ctx.exec.submit(listAction(), null)
    const b = await ctx.exec.submit(listAction(), null)
    expect(a.status).toBe('running')
    expect(b.status).toBe('duplicate')
    await settleIntents(db)
    expect(listIntents(db).length).toBe(1)
  })

  test('manual approval mode holds actions for approval and expires stale proposals', async () => {
    const db = makeDb()
    seedCollection(db)
    const { ctx } = await makeCtx(db, { approvalMode: 'manual', proposals: { ttlSec: 30 } })
    const buy: Action = {
      key: 'buy:x', kind: 'buy', strategy: 'buy', collection: COLL, tokenId: '5', params: { collection: COLL, tokenId: '5', maxPrice: '5000000' },
      spend: U(5), gasEstimate: 1000n, summary: 'buy',
    }
    seedListing(db, '5', '0x00000000000000000000000000000000000000ee', U(5))
    const r = await ctx.exec.submit(buy, null)
    expect(r.status).toBe('proposed')
    expect(getIntent(db, 'buy:x')?.status).toBe('proposed')
    expect(spendTotals(db, Math.floor(Date.now() / 1000)).day).toBe(0n) // nothing reserved before approval
    expect(ctx.exec.approve('buy:x').ok).toBe(true)
    await settleIntents(db)
    expect(getIntent(db, 'buy:x')?.status).toBe('confirmed')
    // proposals past their expiry never run
    db.query("UPDATE intents SET status = 'proposed', expires_ts = 1 WHERE key = 'buy:x'").run()
    expect(ctx.exec.approve('buy:x').ok).toBe(false)
    expect(getIntent(db, 'buy:x')?.status).toBe('expired')
  })

  test('a failed intent refunds its reserved spend', async () => {
    const db = makeDb()
    seedCollection(db)
    // Listing price above maxPrice makes the paper fill fail after spend is reserved.
    seedListing(db, '5', '0x00000000000000000000000000000000000000ee', U(9))
    const { ctx } = await makeCtx(db)
    const buy: Action = {
      key: 'buy:fail', kind: 'buy', strategy: 'buy', collection: COLL, tokenId: '5', params: { collection: COLL, tokenId: '5', maxPrice: '5000000' },
      spend: U(5), gasEstimate: 1000n, summary: 'buy',
    }
    await ctx.exec.submit(buy, null)
    await settleIntents(db)
    expect(getIntent(db, 'buy:fail')?.status).toBe('failed')
    expect(spendTotals(db, Math.floor(Date.now() / 1000)).day).toBe(0n)
  })

  test('global pause blocks new actions and anything queued behind it', async () => {
    const db = makeDb()
    seedCollection(db)
    const t = await makeCtx(db, { approvalMode: 'manual' })
    const r1 = await t.ctx.exec.submit(listAction({ key: 'a1', kind: 'approveCollection', params: { collection: COLL } }), null)
    expect(r1.status).toBe('proposed')
    t.setSettings({ approvalMode: 'manual', paused: true })
    expect((await t.ctx.exec.submit(listAction({ key: 'a2' }), null)).status).toBe('blocked')
    expect(t.ctx.exec.approve('a1').ok).toBe(false)
  })

  test('changing mode between proposal and execution rejects the intent', async () => {
    const db = makeDb()
    seedCollection(db)
    const t = await makeCtx(db, { approvalMode: 'manual' })
    await t.ctx.exec.submit(listAction({ key: 'm1', kind: 'approveCollection', params: { collection: COLL } }), null)
    t.setSettings({ approvalMode: 'manual', mode: 'testnet-live' })
    expect(t.ctx.exec.approve('m1').ok).toBe(false)
  })

  test('restart recovery: a claimed intent without a transaction id is re-run exactly once with the same idempotency key', async () => {
    const db = makeDb()
    seedCollection(db)
    seedToken(db, '1', '0x00000000000000000000000000000000000000ee')
    const calls: string[] = []
    const live: Executor = {
      mode: 'testnet-live',
      submit: (intent) => {
        calls.push(uuidFromKey(intent.key))
        return Promise.resolve({ circleTxId: 'tx-1' })
      },
      track: (): Promise<TrackResult> => Promise.resolve({ ok: true, txHash: '0xabc', gasUsed: 100_000n, gasCostUsdc: 5000n }),
    }
    const t = await makeCtx(db, { mode: 'paper' }, live)
    // Simulate a crash after the intent was claimed ('pending') but before the provider call returned.
    db.query(
      "INSERT INTO intents (key, kind, strategy, params, status, mode, collection, token_id, spend, created_ts, updated_ts) VALUES ('crash:1', 'cancelListing', 'list', ?, 'pending', 'testnet-live', ?, '1', '0', 1, 1)",
    ).run(JSON.stringify({ collection: COLL, tokenId: '1' }), COLL)
    t.setSettings({ mode: 'testnet-live' })
    t.ctx.exec.recover()
    await settleIntents(db)
    await new Promise((r) => setTimeout(r, 50))
    expect(getIntent(db, 'crash:1')?.status).toBe('confirmed')
    expect(calls.length).toBe(1)
    t.ctx.exec.recover() // recovering again must not resend
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.length).toBe(1)
  })

  test('transient provider failures are retried with the same idempotency key, permanent ones are not', async () => {
    const db = makeDb()
    seedCollection(db)
    let attempts = 0
    const keys = new Set<string>()
    const live: Executor = {
      mode: 'testnet-live',
      submit: (intent) => {
        attempts++
        keys.add(uuidFromKey(intent.key))
        if (attempts < 2) return Promise.reject(Object.assign(new Error('rate limited'), { response: { status: 429 } }))
        return Promise.resolve({ circleTxId: 'tx-2' })
      },
      track: (): Promise<TrackResult> => Promise.resolve({ ok: true, txHash: '0xdef' }),
    }
    const t = await makeCtx(db, { mode: 'testnet-live' }, live)
    await t.ctx.exec.submit(listAction({ key: 'retry:1', kind: 'approveCollection', params: { collection: COLL } }), null)
    for (let i = 0; i < 6 && getIntent(db, 'retry:1')?.status !== 'confirmed'; i++) {
      await new Promise((r) => setTimeout(r, 30))
      db.query("UPDATE intents SET updated_ts = 1 WHERE key = 'retry:1' AND status = 'approved'").run()
      t.ctx.exec.processApproved()
    }
    await settleIntents(db)
    expect(getIntent(db, 'retry:1')?.status).toBe('confirmed')
    expect(attempts).toBe(2)
    expect(keys.size).toBe(1)

    const bad: Executor = { ...live, submit: () => Promise.reject(Object.assign(new Error('bad request'), { response: { status: 400 } })) }
    const t2 = await makeCtx(makeDb(), { mode: 'testnet-live' }, bad)
    seedCollection(t2.ctx.db)
    await t2.ctx.exec.submit(listAction({ key: 'perm:1', kind: 'approveCollection', params: { collection: COLL } }), null)
    await settleIntents(t2.ctx.db)
    expect(getIntent(t2.ctx.db, 'perm:1')?.status).toBe('failed')
  })
})

describe('signing allowlist', () => {
  const db = makeDb()
  seedCollection(db)
  const env = testEnv()
  const settings = settingsWith()
  test('builds exact calls for allowed actions', () => {
    const c = prepareCall(listAction({ kind: 'buy', params: { collection: COLL, tokenId: '3', maxPrice: '1000000' } }), db, env, settings)
    expect(c.contractAddress).toBe(MARKET)
    expect(c.abiFunctionSignature).toBe('buy(address,uint256,uint256)')
    expect(c.abiParameters).toEqual([COLL.toLowerCase(), '3', '1000000'])
  })
  test('approvals are only ever granted to the market, and amounts are capped', () => {
    const ok = prepareCall(listAction({ kind: 'approveCollection', params: { collection: COLL, operator: '0xevil' } }), db, env, settings)
    expect(ok.abiParameters[0]).toBe(MARKET) // the caller-supplied operator is ignored
    expect(() => prepareCall(listAction({ kind: 'approveUsdc', params: { spender: '0x00000000000000000000000000000000000000ee', amount: '1' } }), db, env, settings)).toThrow(PolicyError)
    expect(() => prepareCall(listAction({ kind: 'approveUsdc', params: { spender: MARKET, amount: (settings.risk.maxExposurePerCollection + 1n).toString() } }), db, env, settings)).toThrow(PolicyError)
  })
  test('rejects collections that are not registered and verified', () => {
    expect(() => prepareCall(listAction({ kind: 'list', params: { collection: '0x00000000000000000000000000000000000000ab', tokenId: '1', price: '1000', expiry: '0' } }), db, env, settings)).toThrow(PolicyError)
  })
  test('rejects malformed numeric parameters', () => {
    expect(() => prepareCall(listAction({ kind: 'buy', params: { collection: COLL, tokenId: '-1', maxPrice: '1' } }), db, env, settings)).toThrow(PolicyError)
    expect(() => prepareCall(listAction({ kind: 'buy', params: { collection: COLL, tokenId: '1', maxPrice: '1e18' } }), db, env, settings)).toThrow(PolicyError)
  })
  test('mint quantity cannot exceed the configured limit', () => {
    expect(() => prepareCall(listAction({ kind: 'mint', params: { collection: COLL, quantity: '9' } }), db, env, settings)).toThrow(PolicyError)
  })
})

describe('emergency stop', () => {
  test('system cancellations still run while the global pause is on; everything else is blocked', async () => {
    const t = await makeCtx(makeDb(), { paused: true })
    seedCollection(t.ctx.db)
    const normal = await t.ctx.exec.submit(listAction({ key: 'normal:cancel', strategy: 'list' }), null)
    expect(normal.status).toBe('blocked')
    const buy = await t.ctx.exec.submit(listAction({ key: 'normal:buy', kind: 'buy', strategy: 'buy', params: { collection: COLL, tokenId: '1', maxPrice: '1000000' } }), null)
    expect(buy.status).toBe('blocked')
    const emergency = await t.ctx.exec.submit(listAction({ key: 'panic:cancel:1', strategy: 'system' }), null)
    expect(emergency.status).toBe('running')
    await settleIntents(t.ctx.db)
    expect(getIntent(t.ctx.db, 'panic:cancel:1')?.status).toBe('confirmed')
  })
})
