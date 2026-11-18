export type ChainFamily = 'evm' | 'solana' | 'other'

/** Stable internal chain identity. Provider slugs belong in adapter mappings, not here. */
export interface ChainRef {
  id: string
  family: ChainFamily
}

export interface CurrencyRef {
  id: string
  symbol: string
  decimals: number
  kind: 'native' | 'token'
  contractAddress?: string
}

export interface ChainMetadata {
  ref: ChainRef
  name: string
  isTestnet: boolean
  nativeCurrency: CurrencyRef
  explorerUrl?: string
}

/** Chain adapter is metadata/read-side only. It cannot sign or submit transactions. */
export interface ChainReadAdapter {
  readonly chain: ChainMetadata
  getExplorerUrl(kind: 'address' | 'transaction', value: string): string | null
}
