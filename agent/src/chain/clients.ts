/**
 * Chain access: multi-RPC fallback transport, optional WebSocket head subscription, and
 * per-endpoint health probing. RPC URLs may embed tokens: they are never logged.
 */
import { createPublicClient, fallback, http, webSocket, type PublicClient } from 'viem'
import { arcTestnet } from 'viem/chains'
import { getUsdc, requireChain } from '../../../src/onchain-facts'
import { ARC_TESTNET_CHAIN_ID, type EnvConfig } from '../config'
import { logger } from '../log'
import { errMessage } from '../util'

const log = logger('chain')

export const chainFacts = requireChain(ARC_TESTNET_CHAIN_ID)
export const USDC_ADDRESS = (getUsdc(ARC_TESTNET_CHAIN_ID)?.address ?? '') as `0x${string}`
if (!USDC_ADDRESS) throw new Error('USDC address missing from onchain facts for Arc Testnet')

export type Client = PublicClient

export function makeClient(env: EnvConfig): Client {
  const transports = env.rpcUrls.map((url) => http(url, { retryCount: 1, timeout: 10_000, batch: true }))
  return createPublicClient({
    chain: arcTestnet,
    transport: fallback(transports, { retryCount: 2 }),
  })
}

export interface HeadSubscription {
  stop: () => void
  connected: () => boolean
}

/**
 * Subscribes to new heads over WebSocket and calls `onHead` for each. If no WebSocket URL is
 * configured the caller keeps polling; this only adds a low-latency trigger on top.
 */
export function subscribeHeads(env: EnvConfig, onHead: (block: bigint) => void): HeadSubscription {
  if (!env.wsUrl) return { stop: () => undefined, connected: () => false }
  let ok = false
  const client = createPublicClient({
    chain: arcTestnet,
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
  return Promise.all(
    env.rpcUrls.map(async (url, index): Promise<ProviderHealth> => {
      const started = Date.now()
      try {
        const c = createPublicClient({ chain: arcTestnet, transport: http(url, { retryCount: 0, timeout: 6000 }) })
        const block = await c.getBlockNumber()
        return { index, ok: true, latencyMs: Date.now() - started, block: block.toString() }
      } catch (e) {
        return { index, ok: false, latencyMs: null, block: null, error: errMessage(e) }
      }
    }),
  )
}
