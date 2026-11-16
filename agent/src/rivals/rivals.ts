/**
 * Simulated rival traders (test fixtures). Separate Circle wallets that mint, list, undercut and bid
 * on the Arc test market so the agent's repricing and bidding can be exercised against live competition.
 * These wallets are registered with role "fixture". By default the agent will not trade with them and
 * their sales never count as independent demand (see analysis/market.ts). Same call allowlist idea as the
 * agent: a small set of fixed signatures, nothing arbitrary.
 */
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem'
import { waitForSuccessfulTransaction } from '../../../src/onchain-wait'
import type { Client } from '../chain/clients'
import { USDC_ADDRESS } from '../chain/clients'
import type { EnvConfig } from '../config'
import type { Db } from '../db'
import { makeCircleClient } from '../exec/circle'
import { uuidFromKey } from '../exec/service'
import { lc } from '../util'

export interface RivalWallet {
  label: string
  address: string
  walletId: string
}

export function loadRivals(db: Db): RivalWallet[] {
  return (
    db.query("SELECT label, address, circle_wallet_id FROM wallets WHERE role = 'fixture' ORDER BY label").all() as Array<{
      label: string; address: string; circle_wallet_id: string | null
    }>
  )
    .filter((r) => r.circle_wallet_id)
    .map((r) => ({ label: r.label, address: r.address, walletId: r.circle_wallet_id as string }))
}

export const CREATE_COLLECTION_SIG =
  'createCollection((string,string,uint256,uint32,uint32,uint64,address,uint96,string,bytes32,uint64))'

const ALLOWED = new Set([
  CREATE_COLLECTION_SIG,
  'mint(uint32)',
  'reveal(bytes32)',
  'setApprovalForAll(address,bool)',
  'approve(address,uint256)',
  'list(address,uint256,uint256,uint64)',
  'updateListing(address,uint256,uint256,uint64)',
  'cancelListing(address,uint256)',
  'makeOffer(address,uint256,bool,uint256,uint64)',
  'updateOffer(uint256,uint256,uint64)',
  'cancelOffer(uint256)',
  'buy(address,uint256,uint256)',
])

export class RivalBot {
  private circle = makeCircleClient()

  constructor(
    private db: Db,
    private env: EnvConfig,
    private client: Client,
  ) {}

  /** Sends one allowlisted call from a rival wallet and waits for it to succeed onchain. */
  async call(
    rival: RivalWallet, to: string, signature: string, params: unknown[], tag: string,
  ): Promise<Hex> {
    if (!ALLOWED.has(signature)) throw new Error(`rival call not allowed: ${signature}`)
    const res = await this.circle.createContractExecutionTransaction({
      walletId: rival.walletId,
      contractAddress: to,
      abiFunctionSignature: signature,
      abiParameters: params as Array<string | boolean | string[]>,
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      idempotencyKey: uuidFromKey(`${rival.label}:${tag}`),
      refId: `rival:${tag}`.slice(0, 100),
    })
    const id = res.data?.id
    if (!id) throw new Error('Circle did not return a transaction id')
    const tx = await waitForSuccessfulTransaction(
      () => this.circle.getTransaction({ id }),
      (r) => r.data?.transaction?.state,
      { intervalMs: 1500, timeoutMs: 180_000, label: tag },
    )
    const hash = tx.data?.transaction?.txHash as Hex | undefined
    if (!hash) throw new Error('no transaction hash')
    const receipt = await this.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (receipt.status !== 'success') throw new Error(`${tag} reverted onchain`)
    return hash
  }

  /** USDC approvals are limited to the market and to registered collections. */
  async approveUsdc(rival: RivalWallet, spender: string, amount: bigint, tag: string): Promise<Hex> {
    const isMarket = this.env.market !== undefined && lc(spender) === lc(this.env.market)
    const isCollection = !!this.db.query('SELECT 1 FROM collections WHERE address = ?').get(lc(spender))
    if (!isMarket && !isCollection) throw new Error('rival approval spender not allowed')
    return this.call(rival, USDC_ADDRESS, 'approve(address,uint256)', [spender, amount.toString()], tag)
  }

  /** Commitment for the collection's hidden trait seed. */
  static newSeed(): { seed: Hex; commitment: Hex } {
    const seed = toHex(crypto.getRandomValues(new Uint8Array(32)))
    const commitment = keccak256(encodeAbiParameters([{ type: 'bytes32' }], [seed]))
    return { seed, commitment }
  }
}
