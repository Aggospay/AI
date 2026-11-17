/**
 * Chain access: multi-RPC fallback transport, optional WebSocket head subscription, and
 * per-endpoint health probing. RPC URLs may embed tokens: they are never logged.
 */
import { createPublicClient, defineChain, fallback, http, webSocket, type Chain, type PublicClient } from 'viem'
import { getUsdc, requireChain } from '../../../src/onchain-facts'
import { ARC_TESTNET_CHAIN_ID, type EnvConfig } from '../config'
import { logger } from '../log'
import { errMessage } from '../util'

const log = logger('chain')

/** Kept as the deployment/default facts for Arc-specific setup and backward compatibility. */
export const chainFacts = requireChain(ARC_TESTNET_CHAIN_ID)
export const USDC_ADDRESS = (getUsdc(ARC_TESTNET_CHAIN_ID)?.address ?? '') as `0x${string}`
if (!USDC_ADDRESS) throw new Error('USDC address missing from onchain facts for Arc Testnet')

export function chainForId(chainId: number): Chain {
  const facts = requireChain(chainId)
  return defineChain({
    id: facts.chainId,
    name: facts.name,
    nativeCurrency: {
      name: facts.nativeCurrency.symbol,
      symbol: facts.nativeCurrency.symbol,
      decimals: facts.nativeCurrency.decimals,
    },
    rpcUrls: { default: { http: facts.rpcUrls } },
    blockExplorers: { default: { name: `${facts.name} explorer`, url: facts.explorerBase } },
    testnet: facts.isTestnet,
  })
}

export type Client = PublicClient

export function makeClient(env: EnvConfig): Client {
  if (env.rpcUrls.length === 0) throw new Error(`No RPC endpoint configured for chain ${env.chainId}`)
  const transports = env.rpcUrls.map((url) => http(url, { retryCount: 1, timeout: 10_000, batch: true }))
  return createPublicClient({
    chain: chainForId(env.chainId),
    transport: fallback(transports, { retryCount: 2 }),
  })
}

export interface HeadSubscription {
  stop: () => void
  connected: () => boolean
}

export function subscribeHeads(env: EnvConfig, onHead: (block: bigint) => void): HeadSubscription {
  if (!env.wsUrl) return { stop: () => undefined, connected: () => false }
  let ok = false
  const client = createPublicClient({
    chain: chainForId(env.chainId),
    transport: webSocket(env.wsUrl, { reconnect: true, keepAlive: { interval: 15_000 } }),
  })
  const unwatch = client.watchBlockNumber({
    emitOnBegin: false,
    onBlockNumber: (n) => {
      ok = true
      onHead(n)
    },
    onError: (e) => {
      ok = false
      log.warn('websocket head subscription error', { error: errMessage(e) })
    },
  })
  return {
    stop: () => unwatch(),
    connected: () => ok,
  }
}

export interface ProviderHealth {
  index: number
  ok: boolean
  latencyMs: number | null
  block: string | null
  error?: string
}

/** Probes each configured RPC endpoint individually. Index only: URLs stay private. */
export async function probeProviders(env: EnvConfig): Promise<ProviderHealth[]> {
  const chain = chainForId(env.chainId)
  return Promise.all(
    env.rpcUrls.map(async (url, index): Promise<ProviderHealth> => {
      const started = Date.now()
      try {
        const c = createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 6000 }) })
        const block = await c.getBlockNumber()
        return { index, ok: true, latencyMs: Date.now() - started, block: block.toString() }
      } catch (e) {
        return { index, ok: false, latencyMs: null, block: null, error: errMessage(e) }
      }
    }),
  )
}
