/**
 * HTTP control plane: REST + Server-Sent Events. Everything except /healthz requires the admin
 * token (Authorization: Bearer ...). Secrets are never returned. The browser never receives keys.
 */
import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { activeOffers, agentAddress, collectionStats, listCollections, walletRoles } from './analysis/market'
import { scoreCollection } from './analysis/scoring'
import type { App } from './app'
import { chainFacts, USDC_ADDRESS } from './chain/clients'
import { SUPPORTED_CHAIN_IDS, type EnvConfig } from './config'
import { kvGet, logActivity, type Db } from './db'
import { getIntent, listIntents } from './exec/intents'
import { logger } from './log'
import { mintPhase, operatorMint } from './strategies/mint'
import { scanOpportunities } from './strategies/buyer'
import { portfolioSummary } from './strategies/portfolio'
import { STUBS } from './stubs'
import { errMessage, lc, nowSec, toJson } from './util'

const log = logger('server')
const TRADING_CONFIRMATION = 'ENABLE TESTNET TRADING'

interface Deps {
  app: App
  db: Db
  env: EnvConfig
  startedAt: number
}

const json = (body: unknown, status = 200): Response =>
  new Response(toJson(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

function authorized(req: Request, token: string | undefined): boolean {
  if (!token) return false
  const header = req.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function startServer({ app, db, env, startedAt }: Deps) {
  const { ctx } = app
  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const enc = new TextEncoder()
  const broadcast = (event: string, data: unknown) => {
    const chunk = enc.encode(`event: ${event}\ndata: ${toJson(data)}\n\n`)
    for (const c of sseClients) {
      try {
        c.enqueue(chunk)
      } catch {
        sseClients.delete(c)
      }
    }
  }
  ctx.bus.on('intent:updated', (i) => broadcast('intent', i))
  ctx.bus.on('market:changed', () => broadcast('market', { ts: Date.now() }))
  ctx.bus.on('settings:changed', () => broadcast('settings', { ts: Date.now() }))
  const heartbeat = setInterval(() => broadcast('ping', { ts: Date.now() }), 15_000)

  const alerts = () => {
    const out: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string; params?: Record<string, number> }> = []
    const st = ctx.indexer.getStatus()
    const s = app.getSettings()
    if (s.paused) out.push({ level: 'warn', code: 'paused', message: 'The global pause switch is on. Nothing will be proposed or executed.' })
    if (st.lastError) out.push({ level: 'error', code: 'indexer', message: `Indexer error: ${st.lastError}` })
    if (st.lagBlocks !== null && st.lagBlocks > 50) out.push({ level: 'warn', code: 'backfill', message: `Indexer is ${st.lagBlocks} blocks behind the chain head.`, params: { n: st.lagBlocks } })
    if (st.lastSyncTs && Date.now() - st.lastSyncTs > 60_000) out.push({ level: 'error', code: 'stale-index', message: 'The indexer has not synced for over a minute. Trading is effectively blocked by the staleness gate.' })
    const prov = kvGet<{ providers: Array<{ ok: boolean }> }>(db, 'health.providers', { providers: [] }).providers
    const down = prov.filter((p) => !p.ok).length
    if (prov.length > 0 && down === prov.length) out.push({ level: 'error', code: 'rpc', message: 'No RPC provider is responding.' })
    else if (down > 0) out.push({ level: 'warn', code: 'rpc-degraded', message: `${down} of ${prov.length} RPC providers are failing.`, params: { n: down, total: prov.length } })
    if (!env.market || !env.factory) out.push({ level: 'error', code: 'config', message: 'Market and factory addresses are not configured.' })
    const live = app.liveExecutorStatus()
    if (s.mode === 'testnet-live' && !live.ready) out.push({ level: 'error', code: 'live-executor', message: live.reason })
    if (!agentAddress(db)) out.push({ level: 'warn', code: 'wallet', message: 'No agent wallet is registered. Run the setup script.' })
    const stuck = listIntents(db, ['submitted', 'pending'], 50).filter((i) => Date.now() - i.updatedTs > 5 * 60_000)
    if (stuck.length) out.push({ level: 'warn', code: 'stuck', message: `${stuck.length} transaction(s) have been in flight for over 5 minutes.`, params: { n: stuck.length } })
    const failed = listIntents(db, ['failed'], 50).filter((i) => Date.now() - i.updatedTs < 3_600_000)
    if (failed.length) out.push({ level: 'warn', code: 'failures', message: `${failed.length} action(s) failed in the last hour.`, params: { n: failed.length } })
    if (!ctx.indexer.getStatus().wsConnected) out.push({ level: 'info', code: 'ws', message: 'WebSocket head subscription is not connected: using short-interval polling.' })
    return out
  }

  const state = async () => {
    const s = app.getSettings()
    const cap = await ctx.own.capital().catch(() => ({ balance: 0n, committedToOffers: 0n, available: 0n }))
    const gasWei = ctx.gas.knownPrice()
    return {
      mode: s.mode, approvalMode: s.approvalMode, paused: s.paused, strategies: s.strategies,
      chain: { id: chainFacts.chainId, name: chainFacts.name, explorer: chainFacts.explorerBase },
      supportedChains: SUPPORTED_CHAIN_IDS,
      addresses: { factory: env.factory ?? null, market: env.market ?? null, usdc: USDC_ADDRESS, agent: agentAddress(db) },
      wallets: [...walletRoles(db).entries()].map(([address, role]) => ({ address, role })),
      indexer: ctx.indexer.getStatus(),
      providers: kvGet(db, 'health.providers', { providers: [] }),
      tasks: app.scheduler.status(),
      capital: cap,
      gasPriceWei: gasWei,
      marketFeeBps: kvGet<number | null>(db, 'market.feeBps', null),
      live: app.liveExecutorStatus(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      alerts: alerts(),
    }
  }

  const server = Bun.serve({
    port: env.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/'
      // Optional: serve the built dashboard (bun run build) when this worker is deployed on its own host.
      if (!url.pathname.startsWith('/api') && url.pathname !== '/healthz' && req.method === 'GET') {
        const root = resolve(process.env.AGENT_DASHBOARD_DIR ?? 'dist')
        if (existsSync(join(root, 'index.html'))) {
          const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
          const file = resolve(root, rel)
          if (file.startsWith(root + '/') && rel && existsSync(file) && Bun.file(file).size > 0) return new Response(Bun.file(file))
          return new Response(Bun.file(join(root, 'index.html')))
        }
      }
      try {
        if (path === '/healthz') {
          const st = ctx.indexer.getStatus()
          const ok = !!st.lastSyncTs && Date.now() - st.lastSyncTs < 120_000
          return json({ ok, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), lagBlocks: st.lagBlocks, lastSyncTs: st.lastSyncTs }, ok ? 200 : 503)
        }
        if (!authorized(req, env.adminToken)) {
          return json({ error: env.adminToken ? 'unauthorized' : 'admin token is not configured' }, 401)
        }
        const method = req.method

        if (path === '/stream' && method === 'GET') {
          let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              ctrl = c
              sseClients.add(c)
              c.enqueue(enc.encode(`event: hello\ndata: {}\n\n`))
            },
            cancel() {
              if (ctrl) sseClients.delete(ctrl)
            },
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } })
        }

        if (method === 'GET') {
          switch (path) {
            case '/state':
              return json(await state())
            case '/settings':
              return json(JSON.parse(toJson(app.getSettings())))
            case '/portfolio':
              return json(await portfolioSummary(ctx))
            case '/opportunities': {
              const { all } = scanOpportunities(ctx)
              return json(all.slice(0, 60))
            }
            case '/collections': {
              const now = nowSec()
              const s = app.getSettings()
              return json(
                listCollections(db).map((c) => {
                  const stats = collectionStats(db, c.address, s, now)
                  const tokens = db.query('SELECT COUNT(*) AS n FROM tokens WHERE collection = ? AND traits IS NOT NULL').get(c.address) as { n: number }
                  return { ...c, phase: mintPhase(c, now), stats, score: scoreCollection(c, stats, tokens.n) }
                }),
              )
            }
            case '/offers': {
              const now = nowSec()
              const agent = agentAddress(db)
              const roles = walletRoles(db)
              const mine = ctx.own.offers()
              const market = activeOffers(db, now).filter((o) => lc(o.bidder) !== agent).map((o) => ({ ...o, bidderRole: roles.get(lc(o.bidder)) ?? 'external' }))
              return json({ mine, market })
            }
            case '/listings': {
              const now = nowSec()
              const agent = agentAddress(db)
              const rows = db.query("SELECT * FROM listings WHERE status = 'active' ORDER BY CAST(price AS INTEGER) ASC LIMIT 200").all() as Array<Record<string, unknown>>
              return json({ mine: ctx.own.listings(), market: rows.filter((r) => Number(r.expiry) === 0 || Number(r.expiry) > now).map((r) => ({ ...r, own: lc(String(r.seller)) === agent })) })
            }
            case '/intents': {
              const status = url.searchParams.get('status')
              return json(listIntents(db, status ? (status.split(',') as never) : undefined, 200))
            }
            case '/activity': {
              const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100))
              const strategy = url.searchParams.get('strategy')
              const rows = strategy
                ? db.query('SELECT * FROM activity WHERE strategy = ? ORDER BY id DESC LIMIT ?').all(strategy, limit)
                : db.query('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit)
              return json(rows)
            }
            case '/sales': {
              const rows = db.query('SELECT * FROM sales ORDER BY ts DESC LIMIT 100').all()
              return json(rows)
            }
            case '/ledger': {
              return json(db.query('SELECT * FROM ledger ORDER BY id DESC LIMIT 200').all())
            }
            case '/stubs':
              return json(STUBS)
            default:
              break
          }
        }

        if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
          // An empty body is fine; a malformed one is rejected so a broken request can never act as a default
          // (for example resuming a paused agent).
          const raw = await req.text()
          let body: Record<string, unknown> = {}
          if (raw.trim() !== '') {
            try {
              const parsed: unknown = JSON.parse(raw)
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
              body = parsed as Record<string, unknown>
            } catch {
              return json({ error: 'request body must be a JSON object' }, 400)
            }
          }
          if (path === '/settings') {
            const next = app.updateSettings(body)
            logActivity(db, { strategy: 'system', message: 'Settings updated by operator' })
            return json(JSON.parse(toJson(next)))
          }
          if (path === '/control/pause') {
            if (typeof body.paused !== 'boolean') return json({ error: '"paused" must be true or false' }, 400)
            const paused = body.paused
            app.updateSettings({ paused })
            logActivity(db, { strategy: 'system', level: paused ? 'warn' : 'info', message: paused ? 'Global pause ON' : 'Global pause OFF' })
            return json({ ok: true, paused })
          }
          if (path === '/control/approval-mode') {
            const mode = body.mode === 'auto' ? 'auto' : 'manual'
            app.updateSettings({ approvalMode: mode })
            logActivity(db, { strategy: 'system', message: `Approval mode set to ${mode}` })
            return json({ ok: true, approvalMode: mode })
          }
          if (path === '/control/mode') {
            const mode = body.mode === 'testnet-live' ? 'testnet-live' : 'paper'
            if (mode === 'testnet-live' && body.confirm !== TRADING_CONFIRMATION) {
              return json({ error: `Type "${TRADING_CONFIRMATION}" to confirm` }, 400)
            }
            app.updateSettings({ mode })
            logActivity(db, { strategy: 'system', level: 'warn', message: `Execution mode set to ${mode}` })
            return json({ ok: true, mode })
          }
          if (path === '/control/strategy') {
            const name = String(body.name)
            if (!['mint', 'buy', 'list', 'offers'].includes(name)) return json({ error: 'unknown strategy' }, 400)
            app.updateSettings({ strategies: { [name]: body.enabled === true } })
            return json({ ok: true })
          }
          if (path === '/control/panic') {
            app.updateSettings({ paused: true })
            let cancelled = 0
            if (body.cancelOffers !== false) {
              for (const o of ctx.own.offers()) {
                const r = await ctx.exec.submit(
                  {
                    key: `panic:cancelOffer:${o.offerId}:${Date.now()}`, kind: 'cancelOffer', strategy: 'system', collection: o.collection,
                    params: { offerId: String(o.offerId) }, spend: 0n, gasEstimate: 0n, summary: `Emergency: cancel offer #${o.offerId}`,
                  },
                  null,
                  { operatorOverride: false },
                )
                if (r.status === 'running') cancelled++
              }
            }
            let delisted = 0
            if (body.cancelListings === true) {
              for (const l of ctx.own.listings()) {
                const r = await ctx.exec.submit(
                  {
                    key: `panic:cancelListing:${l.collection}:${l.tokenId}:${Date.now()}`, kind: 'cancelListing', strategy: 'system', collection: l.collection, tokenId: l.tokenId,
                    params: { collection: l.collection, tokenId: l.tokenId }, spend: 0n, gasEstimate: 0n, summary: `Emergency: delist #${l.tokenId}`,
                  },
                  null,
                  { operatorOverride: false },
                )
                if (r.status === 'running') delisted++
              }
            }
            logActivity(db, { strategy: 'system', level: 'error', message: `EMERGENCY STOP: agent paused, ${cancelled} offer cancellation(s) and ${delisted} delisting(s) issued` })
            return json({ ok: true, cancelled, delisted })
          }
          const m = /^\/intents\/([^/]+)\/(approve|reject)$/.exec(path)
          if (m) {
            const key = decodeURIComponent(m[1])
            if (!getIntent(db, key)) return json({ error: 'unknown intent' }, 404)
            return json(m[2] === 'approve' ? ctx.exec.approve(key) : ctx.exec.reject(key))
          }
          if (path === '/mint') {
            const res = await operatorMint(ctx, String(body.collection), Number(body.quantity ?? 1))
            return json(res, res.ok ? 200 : 400)
          }
        }
        return json({ error: 'not found' }, 404)
      } catch (e) {
        log.warn('request failed', { path, error: errMessage(e) })
        return json({ error: errMessage(e) }, 400)
      }
    },
  })
  log.info(`control plane listening on :${server.port}`)
  return { stop: () => { clearInterval(heartbeat); void server.stop() } }
}
