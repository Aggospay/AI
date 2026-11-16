/**
 * Application assembly: wires the database, chain clients, indexer, execution and strategies together.
 * Used by main.ts (production) and by tests (with an in-memory database and fake chain pieces).
 */
import { marketAbi } from './abis'
import { setMarketFeeBps } from './analysis/fees'
import { Bus, debounce } from './bus'
import { probeProviders, type Client } from './chain/clients'
import { Indexer, refreshTraits } from './chain/indexer'
import { SettingsSchema, parseSettings, serializeSettings, type EnvConfig, type Settings } from './config'
import { kvSet, loadSettings, saveSettings, type Db } from './db'
import { CircleExecutor, circleCredentialsPresent } from './exec/circle'
import { GasOracle } from './exec/gas'
import { PaperExecutor } from './exec/paper'
import { ExecutionService, type Executor } from './exec/service'
import { Scheduler } from './scheduler'
import { OwnState } from './state/own'
import { runBuyer } from './strategies/buyer'
import type { Ctx } from './strategies/ctx'
import { runMint } from './strategies/mint'
import { runOffers } from './strategies/offers'
import { syncPositions } from './strategies/portfolio'
import { runRepricer } from './strategies/repricer'

export interface App {
  ctx: Ctx
  scheduler: Scheduler
  paper: PaperExecutor
  getSettings: () => Settings
  updateSettings: (patch: unknown) => Settings
  liveExecutorStatus: () => { ready: boolean; reason: string }
  registerTasks: () => void
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], v)
  return out
}

export function createApp(db: Db, env: EnvConfig, client: Client): App {
  const bus = new Bus()
  let settings = loadSettings(db)
  const getSettings = () => settings

  const gas = new GasOracle(db, client, env.chainId)
  const own = new OwnState(db, client, getSettings)
  const paper = new PaperExecutor(db)

  let live: CircleExecutor | null = null
  const liveStatus = (): { ready: boolean; reason: string } => {
    if (!circleCredentialsPresent()) return { ready: false, reason: 'Circle API key or entity secret is missing in the environment' }
    if (!CircleExecutor.walletIdFromDb(db)) return { ready: false, reason: 'agent wallet is not registered (run the setup script)' }
    if (!env.market || !env.factory) return { ready: false, reason: 'market and factory addresses are not configured' }
    return { ready: true, reason: 'ready' }
  }
  const liveExecutor = (): Executor | null => {
    if (!liveStatus().ready) return null
    live ??= new CircleExecutor(db, client, () => CircleExecutor.walletIdFromDb(db))
    return live
  }

  const indexer = new Indexer(db, client, env, bus)
  const exec = new ExecutionService(db, env, bus, getSettings, { paper, live: liveExecutor }, gas, {
    onConfirmed: (intent) => {
      own.invalidateBalance()
      indexer.kick()
      bus.emit('intent:updated', intent)
    },
  })
  const ctx: Ctx = { db, client, env, bus, getSettings, own, gas, exec, indexer }
  const scheduler = new Scheduler(db)

  const updateSettings = (patch: unknown): Settings => {
    const current = serializeSettings(settings)
    const merged = deepMerge(current, patch)
    const next = parseSettings(merged)
    // Safety rail: live trading can only be enabled when the live executor is ready.
    if (next.mode === 'testnet-live' && !liveStatus().ready) {
      throw new Error(`Cannot enable testnet trading: ${liveStatus().reason}`)
    }
    SettingsSchema.parse(serializeSettings(next))
    settings = next
    saveSettings(db, next)
    bus.emit('settings:changed', next)
    return next
  }

  const registerTasks = () => {
    const guard = (fn: () => Promise<void>) => async () => {
      if (settings.paused) return
      await fn()
    }
    scheduler.register('gas', 10_000, async () => {
      await gas.refresh(0)
    })
    scheduler.register('market.info', 30_000, async () => {
      if (!env.market) return
      const bps = await client.readContract({ address: env.market, abi: marketAbi, functionName: 'feeBps' })
      setMarketFeeBps(db, Number(bps))
      const paused = await client.readContract({ address: env.market, abi: marketAbi, functionName: 'paused' })
      kvSet(db, 'market.paused', paused)
    })
    scheduler.register('traits', 30_000, async () => {
      await refreshTraits(db, client)
    })
    scheduler.register('health.providers', 30_000, async () => {
      kvSet(db, 'health.providers', { ts: Date.now(), providers: await probeProviders(env) })
    })
    scheduler.register('intents', 3_000, () => {
      exec.expireProposals()
      exec.processApproved()
      return Promise.resolve()
    })
    scheduler.register('portfolio', 10_000, () => {
      syncPositions(ctx)
      return Promise.resolve()
    })
    scheduler.register('paper.fills', 5_000, () => {
      if (settings.mode === 'paper') paper.settleFills(settings.risk.outlierMadMultiple, settings.risk.allowFixtureCounterparties)
      return Promise.resolve()
    })
    scheduler.register('buy', 5_000, guard(() => runBuyer(ctx)))
    scheduler.register('reprice', 5_000, guard(() => runRepricer(ctx)))
    scheduler.register('offers', 8_000, guard(() => runOffers(ctx)))
    scheduler.register('mint', 1_000, guard(() => runMint(ctx)))

    const onMarket = debounce(() => {
      scheduler.trigger('reprice')
      scheduler.trigger('offers')
      scheduler.trigger('buy')
      scheduler.trigger('portfolio')
    }, 400)
    bus.on('market:changed', onMarket)
    bus.on('head', () => scheduler.trigger('mint'))
    bus.on('settings:changed', () => {
      for (const t of ['buy', 'reprice', 'offers', 'mint']) scheduler.trigger(t)
    })
    bus.on('intent:updated', () => scheduler.trigger('reprice'))
    scheduler.start()
  }

  return { ctx, scheduler, paper, getSettings, updateSettings, liveExecutorStatus: liveStatus, registerTasks }
}
