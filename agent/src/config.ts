/**
 * Runtime settings. Stored as JSON in SQLite (amounts as base-unit decimal strings),
 * validated with zod, exposed to code as bigint. Defaults are conservative: paper mode,
 * manual approval, small limits. All money is USDC in the 6-decimal ERC-20 view.
 */
import { z } from 'zod'

export const ARC_TESTNET_CHAIN_ID = 5042002
/** The only chain this build will trade on. Mainnet chain IDs are rejected on purpose. */
export const SUPPORTED_CHAIN_IDS: readonly number[] = [ARC_TESTNET_CHAIN_ID]

export const PRICE_TICK = 1000n // 0.001 USDC, mirrors NftMarket.PRICE_TICK
export const BPS = 10_000n

const amount = (def: string) =>
  z
    .string()
    .regex(/^\d+$/, 'amount must be a base-unit integer string')
    .default(def)
    .transform((v) => BigInt(v))

const addrList = z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).default([])

export const SettingsSchema = z.object({
  mode: z.enum(['paper', 'testnet-live']).default('paper'),
  approvalMode: z.enum(['manual', 'auto']).default('manual'),
  /** Global pause: nothing is proposed or executed while true. */
  paused: z.boolean().default(false),
  strategies: z
    .object({
      mint: z.boolean().default(true),
      buy: z.boolean().default(true),
      list: z.boolean().default(true),
      offers: z.boolean().default(true),
    })
    .prefault({}),
  risk: z
    .object({
      maxMintPrice: amount('5000000'), // per token
      maxPurchasePrice: amount('20000000'),
      minNetProfit: amount('500000'),
      minRoiBps: z.number().int().min(0).default(500),
      maxDailySpend: amount('50000000'),
      maxWeeklySpend: amount('200000000'),
      maxExposurePerCollection: amount('60000000'),
      maxTokensPerCollection: z.number().int().min(1).default(10),
      maxCollectionAllocationBps: z.number().int().min(0).max(10000).default(4000),
      minLiquiditySales: z.number().int().min(0).default(2),
      minLiquidityWindowSec: z.number().int().min(60).default(86_400),
      minDistinctBuyers: z.number().int().min(0).default(2),
      maxGasCostPerTx: amount('100000'), // USDC base units
      minCollectionScore: z.number().min(0).max(100).default(55),
      minScoreCoverage: z.number().min(0).max(1).default(0.5),
      maxPriceAgeSec: z.number().int().min(5).default(300),
      /** Reject if the listing / fair value spread looks too good: probable manipulation or stale data. */
      maxFairValueDiscountBps: z.number().int().min(0).default(6000),
      outlierMadMultiple: z.number().min(1).default(4),
      otherCostsPerTrade: amount('0'),
      allowlist: addrList,
      blocklist: addrList,
      requireVerifiedCollection: z.boolean().default(true),
      /** Test harness only: allow trading against wallets labelled as simulated fixtures. */
      allowFixtureCounterparties: z.boolean().default(false),
    })
    .prefault({}),
  pricing: z
    .object({
      undercutTicks: z.number().int().min(1).default(1),
      repriceCooldownSec: z.number().int().min(0).default(45),
      minChangeTicks: z.number().int().min(1).default(1),
      maxRepricesPerHour: z.number().int().min(1).default(20),
      raiseThresholdTicks: z.number().int().min(1).default(3),
      listingDurationSec: z.number().int().min(300).default(86_400),
      /** Expected holding period used for the profit model. */
      expectedHoldingSec: z.number().int().min(60).default(43_200),
      /** Fair-value haircut applied to expected resale (execution risk). */
      resaleHaircutBps: z.number().int().min(0).max(5000).default(300),
    })
    .prefault({}),
  offers: z
    .object({
      incrementTicks: z.number().int().min(1).default(1),
      durationSec: z.number().int().min(300).default(3600),
      renewBeforeSec: z.number().int().min(30).default(300),
      cooldownSec: z.number().int().min(0).default(30),
      maxOpenOffers: z.number().int().min(0).default(6),
      maxCapitalInOffers: amount('40000000'),
      targets: addrList,
    })
    .prefault({}),
  mint: z
    .object({
      quantity: z.number().int().min(1).max(10).default(1),
      /** Require observed secondary prices before auto-minting (otherwise only propose). */
      requireSecondaryReference: z.boolean().default(true),
    })
    .prefault({}),
  watch: z
    .object({
      collections: addrList, // empty = every factory-created collection
      scanIntervalSec: z.number().int().min(1).default(5),
    })
    .prefault({}),
  proposals: z
    .object({
      ttlSec: z.number().int().min(30).default(900),
    })
    .prefault({}),
})

export type Settings = z.output<typeof SettingsSchema>
export type SettingsInput = z.input<typeof SettingsSchema>

/** Convert settings with bigint fields into the JSON-safe stored shape. */
export function serializeSettings(settings: Settings): unknown {
  return JSON.parse(
    JSON.stringify(settings, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  )
}

export function parseSettings(raw: unknown): Settings {
  return SettingsSchema.parse(raw ?? {})
}

export const defaultSettings = (): Settings => SettingsSchema.parse({})

/** Environment configuration (never contains secrets in logs; see log.ts redaction). */
export interface EnvConfig {
  chainId: number
  dbPath: string
  port: number
  adminToken: string | undefined
  factory: `0x${string}` | undefined
  market: `0x${string}` | undefined
  startBlock: bigint | undefined
  wsUrl: string | undefined
  rpcUrls: string[]
}

const addr = (v: string | undefined): `0x${string}` | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined

export function loadEnv(rpcUrlsFromFacts: string[]): EnvConfig {
  const chainId = Number(process.env.AGENT_CHAIN_ID ?? ARC_TESTNET_CHAIN_ID)
  if (!SUPPORTED_CHAIN_IDS.includes(chainId)) {
    throw new Error(`Chain ${chainId} is not supported. This build trades on Arc Testnet only.`)
  }
  const urls: string[] = []
  const proxyChains = (process.env.RPC_PROXY_CHAINS ?? '').split(',')
  const keyed = process.env['RPC_URL_Arc_Testnet']
  if (keyed) urls.push(keyed)
  if (process.env.RPC_PROXY_BASE_URL && process.env.RPC_PROXY_TOKEN && proxyChains.includes('Arc_Testnet')) {
    urls.push(`${process.env.RPC_PROXY_BASE_URL}/api/rpc/Arc_Testnet?_rpc_token=${process.env.RPC_PROXY_TOKEN}`)
  }
  for (const u of rpcUrlsFromFacts) if (!urls.includes(u)) urls.push(u)
  return {
    chainId,
    dbPath: process.env.AGENT_DB_PATH ?? 'agent/data/agent.sqlite',
    port: Number(process.env.AGENT_PORT ?? 8787),
    adminToken: process.env.AGENT_ADMIN_TOKEN,
    factory: addr(process.env.VITE_FACTORY_ADDRESS),
    market: addr(process.env.VITE_MARKET_ADDRESS),
    startBlock: process.env.AGENT_START_BLOCK ? BigInt(process.env.AGENT_START_BLOCK) : undefined,
    wsUrl: process.env.AGENT_WS_URL,
    rpcUrls: urls,
  }
}
