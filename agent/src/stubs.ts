/**
 * Features in the product spec that are NOT implemented in this build. Each entry says what is
 * missing and what it needs. The dashboard renders this list verbatim so nothing is overstated.
 * Typed interfaces below mark where an implementation would plug in; none of them do any work.
 */

export type StubStatus = 'not-implemented' | 'partial'

export interface StubFeature {
  id: string
  name: string
  status: StubStatus
  what: string
  needs: string
}

export const STUBS: StubFeature[] = [
  {
    id: 'predictive-floor', name: 'Predictive floor analysis', status: 'not-implemented',
    what: 'Forecasting floor-price moves from history, volume and buyer activity.',
    needs: 'A longer price history than a fresh testnet provides, plus a validated forecasting model.',
  },
  {
    id: 'cross-market-arbitrage', name: 'Cross-marketplace arbitrage', status: 'not-implemented',
    what: 'Buying on one marketplace and reselling on another after all fees.',
    needs: 'A second live marketplace adapter. Only the Arc test market is connected, and OpenSea, Blur, Magic Eden and Reservoir are not available on testnet.',
  },
  {
    id: 'whale-monitoring', name: 'Whale monitoring', status: 'not-implemented',
    what: 'Tracking significant wallets and following their buys, sells and listings.',
    needs: 'Wallet labelling data and enough organic trading activity to define who counts as a whale.',
  },
  {
    id: 'adaptive-pricing', name: 'Adaptive pricing from sale velocity', status: 'not-implemented',
    what: 'Learning the best undercut size and cooldown per collection from past sales.',
    needs: 'Hundreds of completed trades per collection. Pricing currently uses fixed, configurable rules.',
  },
  {
    id: 'strategy-optimization', name: 'Strategy optimization', status: 'partial',
    what: 'Outcome tracking exists (realized result per collection score is recorded). No model uses it yet.',
    needs: 'Enough closed trades to calibrate score weights without overfitting.',
  },
  {
    id: 'llm-research', name: 'AI research and sentiment', status: 'not-implemented',
    what: 'Social, community and team research feeding the collection score.',
    needs: 'A social data source and a language model integration. Team and community components are reported as unscored.',
  },
  {
    id: 'trait-offers', name: 'Trait offers', status: 'not-implemented',
    what: 'Bids that match any token with a given trait.',
    needs: 'Marketplace contract support. The market supports token offers and collection-wide offers only.',
  },
  {
    id: 'mainnet-and-other-chains', name: 'Ethereum, Base and other chains', status: 'not-implemented',
    what: 'Trading on Ethereum mainnet, Base mainnet or other networks.',
    needs: 'Arc Studio is testnet-only. The code rejects any chain except Arc Testnet. Add a MarketAdapter for each network and review it independently first.',
  },
]

export interface PredictiveFloorModel {
  predict(collection: string, horizonSec: number): Promise<{ floor: bigint; confidence: number }>
}
export interface CrossMarketAdapter {
  name: string
  quote(collection: string, tokenId: string): Promise<{ price: bigint; url: string } | null>
}
export interface WhaleFeed {
  recent(collection: string): Promise<Array<{ wallet: string; action: 'buy' | 'sell' | 'list'; tokenId: string; ts: number }>>
}
