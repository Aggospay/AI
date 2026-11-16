/**
 * Typed client for the agent worker. The admin token lives in sessionStorage only (cleared when the tab
 * closes) and is sent as a Bearer header. The browser never receives wallet keys or Circle credentials.
 * Amounts arrive as base-unit decimal strings (6-decimal USDC).
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

const TOKEN_KEY = 'agent.adminToken'
export const getToken = (): string => sessionStorage.getItem(TOKEN_KEY) ?? ''
export const setToken = (t: string): void => sessionStorage.setItem(TOKEN_KEY, t)
export const clearToken = (): void => sessionStorage.removeItem(TOKEN_KEY)

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    throw new ApiError(message, res.status)
  }
  return data as T
}

/** Server-Sent Events over fetch, so the Authorization header can be sent. Invalidates queries on pushes. */
export function useAgentStream(enabled: boolean): void {
  const qc = useQueryClient()
  const abort = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!enabled) return
    const flag = { stopped: false }
    const run = async () => {
      while (!flag.stopped) {
        const ctrl = new AbortController()
        abort.current = ctrl
        try {
          const res = await fetch('/api/stream', { headers: { Authorization: `Bearer ${getToken()}` }, signal: ctrl.signal })
          if (!res.ok || !res.body) throw new Error('stream unavailable')
          const reader = res.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let idx: number
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const ev = /^event: (.+)$/m.exec(block)?.[1]
              if (ev === 'intent') {
                void qc.invalidateQueries({ queryKey: ['intents'] })
                void qc.invalidateQueries({ queryKey: ['activity'] })
                void qc.invalidateQueries({ queryKey: ['portfolio'] })
              } else if (ev === 'market') {
                void qc.invalidateQueries({ queryKey: ['opportunities'] })
                void qc.invalidateQueries({ queryKey: ['orders'] })
                void qc.invalidateQueries({ queryKey: ['collections'] })
                void qc.invalidateQueries({ queryKey: ['portfolio'] })
              } else if (ev === 'settings') {
                void qc.invalidateQueries()
              }
            }
          }
        } catch {
          // Reconnect below.
        }
        if (!flag.stopped) await new Promise((r) => setTimeout(r, 3000))
      }
    }
    void run()
    return () => {
      flag.stopped = true
      abort.current?.abort()
    }
  }, [enabled, qc])
}

// ------------------------------------------------------------------ types

export interface Alert {
  level: 'info' | 'warn' | 'error'
  code: string
  message: string
  params?: Record<string, number>
}

export interface AgentState {
  mode: 'paper' | 'testnet-live'
  approvalMode: 'manual' | 'auto'
  paused: boolean
  strategies: { mint: boolean; buy: boolean; list: boolean; offers: boolean }
  chain: { id: number; name: string; explorer: string }
  addresses: { factory: string | null; market: string | null; usdc: string; agent: string | null }
  wallets: Array<{ address: string; role: string }>
  indexer: { cursor: number | null; head: number | null; lagBlocks: number | null; lastSyncTs: number | null; lastError: string | null; wsConnected: boolean; eventsIndexed: number }
  providers: { providers: Array<{ index: number; ok: boolean; latencyMs: number | null; block: string | null }> }
  tasks: Array<{ name: string; lastRun: number | null; lastStatus: string | null; lastError: string | null; intervalMs: number; runs: number }>
  capital: { balance: string; committedToOffers: string; available: string }
  gasPriceWei: string | null
  marketFeeBps: number | null
  live: { ready: boolean; reason: string }
  uptimeSec: number
  alerts: Alert[]
}

export interface Holding {
  collection: string
  collectionName: string
  tokenId: string
  source: string
  acquiredPrice: string
  acquiredCost: string
  acquiredTs: number
  listingPrice: string | null
  listingExpiry: number | null
  markValue: string | null
  markNet: string | null
  unrealized: string | null
  minProfitablePrice: string | null
  lowestCompetitor: string | null
  tier: number | null
  recommendation: 'hold' | 'list' | 'reprice' | 'sell' | 'delist'
  reason: string
}

export interface Portfolio {
  mode: string
  capital: { balance: string; committedToOffers: string; available: string }
  totalCapital: string
  totalValue: string
  realized: string
  unrealized: string
  realizedDay: string
  realizedWeek: string
  gasTotal: string
  feesPaid: string
  holdings: Holding[]
  exposure: Array<{ collection: string; name: string; tokens: number; positionCost: string; offerCapital: string; shareBps: number }>
  counts: { open: number; listings: number; offers: number; collections: number }
}

export interface Opportunity {
  collection: string
  tokenId: string
  seller: string
  price: string
  tier: number
  fairValue: string
  expectedResale: string
  score: number
  confidence: number
  profit: {
    netProfit: string
    roiBps: string
    marketFee: string
    royalty: string
    totalCost: string
    breakEvenPrice: string
    ok: boolean
    reasons: string[]
  }
}

export interface ScoreComponent {
  name: string
  max: number
  points: number | null
  note: string
}

export interface CollectionView {
  address: string
  name: string
  symbol: string
  creator: string
  mintPrice: string
  maxSupply: number
  maxPerWallet: number
  mintStart: number
  mintEnd: number
  totalMinted: number
  revealed: boolean
  phase: 'upcoming' | 'live' | 'closed' | 'soldout'
  stats: {
    floor: string | null
    activeListings: number
    salesCount: number
    excludedSales: number
    uniqueBuyers: number
    volume: string
    fairValue: string | null
    confidence: number
    bestCollectionOffer: string | null
    holders: number
    topHolderShareBps: number
  }
  score: { score: number; coverage: number; components: ScoreComponent[] }
}

export interface IntentView {
  key: string
  kind: string
  strategy: string
  status: 'proposed' | 'approved' | 'pending' | 'submitted' | 'confirmed' | 'failed' | 'rejected' | 'expired'
  mode: string
  summary: string
  analysis: Record<string, unknown> | null
  estCost: string
  spend: string
  txHash: string | null
  error: string | null
  createdTs: number
  updatedTs: number
  expiresTs: number | null
  collection?: string
  tokenId?: string
}

export interface ActivityRow {
  id: number
  ts: number
  level: 'info' | 'warn' | 'error'
  strategy: string
  message: string
}

export interface OrdersView {
  listings: { mine: Array<{ collection: string; tokenId: string; price: string; expiry: number; updatedTs: number }>; market: Array<{ collection: string; token_id: string; seller: string; price: string; expiry: number; own: boolean }> }
  offers: { mine: Array<{ offerId: number; collection: string; tokenId: string; collectionWide: boolean; price: string; expiry: number }>; market: Array<{ offerId: number; collection: string; tokenId: string; collectionWide: boolean; bidder: string; bidderRole: string; price: string; expiry: number }> }
}

export interface StubFeature {
  id: string
  name: string
  status: string
  what: string
  needs: string
}
