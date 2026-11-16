/**
 * Signing allowlist. The agent can only ever produce calls built here: fixed contracts, fixed
 * function signatures, parameters validated against the indexed state. There is no code path that
 * signs arbitrary calldata, arbitrary messages, or typed data.
 */
import { isAddress } from 'viem'
import type { EnvConfig, Settings } from '../config'
import type { Db } from '../db'
import type { Action, ActionKind } from '../types'
import { lc } from '../util'
import { USDC_ADDRESS } from '../chain/clients'

export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}

export interface PreparedCall {
  contractAddress: `0x${string}`
  abiFunctionSignature: string
  abiParameters: Array<string | boolean>
}

const SIGNATURES: Record<ActionKind, string> = {
  mint: 'mint(uint32)',
  buy: 'buy(address,uint256,uint256)',
  list: 'list(address,uint256,uint256,uint64)',
  updateListing: 'updateListing(address,uint256,uint256,uint64)',
  cancelListing: 'cancelListing(address,uint256)',
  makeOffer: 'makeOffer(address,uint256,bool,uint256,uint64)',
  updateOffer: 'updateOffer(uint256,uint256,uint64)',
  cancelOffer: 'cancelOffer(uint256)',
  acceptOffer: 'acceptOffer(uint256,uint256,uint256)',
  approveCollection: 'setApprovalForAll(address,bool)',
  approveUsdc: 'approve(address,uint256)',
}

const UINT = /^\d{1,78}$/
const need = (p: Record<string, string | boolean>, name: string): string => {
  const v = p[name]
  if (typeof v !== 'string' || !UINT.test(v)) throw new PolicyError(`parameter ${name} must be an unsigned integer string`)
  return v
}

function verifiedCollection(db: Db, address: string): string {
  if (!isAddress(address)) throw new PolicyError('collection is not an address')
  const row = db.query('SELECT 1 FROM collections WHERE address = ? AND verified = 1').get(lc(address))
  if (!row) throw new PolicyError('collection is not a registered, verified collection')
  return lc(address)
}

/** Validates an action against the allowlist and returns the exact call to sign. Throws PolicyError otherwise. */
export function prepareCall(action: Action, db: Db, env: EnvConfig, settings: Settings): PreparedCall {
  if (!env.market || !env.factory) throw new PolicyError('market and factory addresses are not configured')
  const market = env.market
  const p = action.params
  const sig = SIGNATURES[action.kind]
  if (!sig) throw new PolicyError(`action kind ${action.kind} is not allowed`)

  switch (action.kind) {
    case 'mint': {
      const collection = verifiedCollection(db, String(p.collection))
      const q = need(p, 'quantity')
      if (Number(q) < 1 || Number(q) > settings.mint.quantity) throw new PolicyError('mint quantity outside configured limit')
      return { contractAddress: collection as `0x${string}`, abiFunctionSignature: sig, abiParameters: [q] }
    }
    case 'approveCollection': {
      const collection = verifiedCollection(db, String(p.collection))
      // Only ever approve the market, never an arbitrary operator.
      return {
        contractAddress: collection as `0x${string}`,
        abiFunctionSignature: sig,
        abiParameters: [market, true],
      }
    }
    case 'approveUsdc': {
      const spender = String(p.spender)
      const amount = need(p, 'amount')
      const isMarket = lc(spender) === lc(market)
      const isCollection = !isMarket && !!db.query('SELECT 1 FROM collections WHERE address = ? AND verified = 1').get(lc(spender))
      if (!isMarket && !isCollection) throw new PolicyError('USDC approval spender is not the market or a verified collection')
      if (BigInt(amount) > settings.risk.maxExposurePerCollection) throw new PolicyError('USDC approval exceeds the per-collection exposure cap')
      return { contractAddress: USDC_ADDRESS, abiFunctionSignature: sig, abiParameters: [spender, amount] }
    }
    case 'buy':
      return {
        contractAddress: market, abiFunctionSignature: sig,
        abiParameters: [verifiedCollection(db, String(p.collection)), need(p, 'tokenId'), need(p, 'maxPrice')],
      }
    case 'list':
    case 'updateListing':
      return {
        contractAddress: market, abiFunctionSignature: sig,
        abiParameters: [verifiedCollection(db, String(p.collection)), need(p, 'tokenId'), need(p, 'price'), need(p, 'expiry')],
      }
    case 'cancelListing':
      return {
        contractAddress: market, abiFunctionSignature: sig,
        abiParameters: [verifiedCollection(db, String(p.collection)), need(p, 'tokenId')],
      }
    case 'makeOffer':
      return {
        contractAddress: market, abiFunctionSignature: sig,
        abiParameters: [
          verifiedCollection(db, String(p.collection)), need(p, 'tokenId'), p.collectionWide === true,
          need(p, 'price'), need(p, 'expiry'),
        ],
      }
    case 'updateOffer':
      return {
        contractAddress: market, abiFunctionSignature: sig,
        abiParameters: [need(p, 'offerId'), need(p, 'price'), need(p, 'expiry')],
      }
    case 'cancelOffer':
      return { contractAddress: market, abiFunctionSignature: sig, abiParameters: [need(p, 'offerId')] }
    case 'acceptOffer': {
      const wide = p.collectionWide === true
      return {
        contractAddress: market,
        abiFunctionSignature: wide ? 'acceptCollectionOffer(uint256,uint256,uint256)' : sig,
        abiParameters: [need(p, 'offerId'), need(p, 'tokenId'), need(p, 'minPrice')],
      }
    }
    default:
      throw new PolicyError('unsupported action')
  }
}
