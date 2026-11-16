/**
 * One-time setup for Circle developer-controlled wallets on Arc Testnet.
 *   bun run agent:setup wallets     create (or show) the agent, treasury and rival wallets
 * Addresses are public. Wallet ids are stored in the agent database. No keys are ever handled here.
 */
import { chainFacts } from './chain/clients'
import { loadEnv } from './config'
import { openDb } from './db'
import { makeCircleClient } from './exec/circle'

const ROLES: Array<{ label: string; role: 'agent' | 'treasury' | 'fixture' }> = [
  { label: 'agent', role: 'agent' },
  { label: 'treasury', role: 'treasury' },
  { label: 'rival-1', role: 'fixture' },
  { label: 'rival-2', role: 'fixture' },
]

async function wallets() {
  const env = loadEnv(chainFacts.rpcUrls)
  const db = openDb(env.dbPath)
  const existing = db.query('SELECT address, label, role FROM wallets').all() as Array<{ address: string; label: string; role: string }>
  if (existing.length >= ROLES.length) {
    console.log('Wallets already registered:')
    for (const w of existing) console.log(`  ${w.label.padEnd(10)} ${w.role.padEnd(9)} ${w.address}`)
    return
  }
  const circle = makeCircleClient()
  const set = await circle.createWalletSet({ name: 'NFT trading agent (Arc Testnet)' })
  const walletSetId = set.data?.walletSet?.id
  if (!walletSetId) throw new Error('Circle did not return a wallet set id')
  const created = await circle.createWallets({
    blockchains: ['ARC-TESTNET'],
    count: ROLES.length,
    walletSetId,
    accountType: 'EOA',
    metadata: ROLES.map((r) => ({ name: r.label, refId: r.label })),
  })
  const list = created.data?.wallets ?? []
  if (list.length !== ROLES.length) throw new Error(`Expected ${ROLES.length} wallets, got ${list.length}`)
  list.forEach((w, i) => {
    db.query(
      'INSERT OR REPLACE INTO wallets (address, label, role, circle_wallet_id) VALUES (?, ?, ?, ?)',
    ).run(w.address.toLowerCase(), ROLES[i].label, ROLES[i].role, w.id)
    console.log(`  ${ROLES[i].label.padEnd(10)} ${ROLES[i].role.padEnd(9)} ${w.address}`)
  })
  console.log('Wallets created on', chainFacts.name)
}

const cmd = process.argv[2] ?? 'wallets'
if (cmd === 'wallets') {
  wallets().catch((e: unknown) => {
    console.error('setup failed:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
} else {
  console.error('usage: bun run agent:setup wallets')
  process.exit(1)
}
