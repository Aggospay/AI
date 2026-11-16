/**
 * Rival scenario runner (testnet only).
 *   bun run agent:rivals seed                 create a collection, mint, and list rival tokens
 *   bun run agent:rivals undercut [ticks]     rival-2 lists below the agent's current ask
 *   bun run agent:rivals crash <price>        rival-2 lists at an exact price (USDC)
 *   bun run agent:rivals bid <price>          rival-1 places a collection-wide offer
 *   bun run agent:rivals outbid [ticks]       rival-1 raises its offer above the best other offer
 *   bun run agent:rivals buy <r1|r2> <tokenId>  a rival buys another rival's listed token (synthetic sale)
 *   bun run agent:rivals relist <r1|r2> <tokenId> <price>  list or reprice any rival-owned token
 *   bun run agent:rivals reveal               reveal traits once the collection is sold out or ended
 *   bun run agent:rivals status
 * Rival wallets are labelled "fixture" in the registry: the agent will not trade with them unless the
 * test-harness switch is enabled, and nothing here sells to the agent's own wallet.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseUsdc } from '../../../src/onchain-money'
import { activeListings, agentAddress, activeOffers } from '../analysis/market'
import { chainFacts, makeClient } from '../chain/clients'
import { PRICE_TICK, loadEnv } from '../config'
import { openDb } from '../db'
import { CREATE_COLLECTION_SIG, loadRivals, RivalBot, type RivalWallet } from './rivals'
import { lc, nowSec } from '../util'

const SEED_FILE = 'agent/data/rival-seed.json'

async function main() {
  const env = loadEnv(chainFacts.rpcUrls)
  const db = openDb(env.dbPath)
  const client = makeClient(env)
  const rivals = loadRivals(db)
  if (rivals.length < 2) throw new Error('Register wallets first: bun run agent:setup wallets')
  if (!env.market || !env.factory) throw new Error('VITE_MARKET_ADDRESS / VITE_FACTORY_ADDRESS are not set')
  const bot = new RivalBot(db, env, client)
  const [r1, r2] = rivals as [RivalWallet, RivalWallet]
  const cmd = process.argv[2] ?? 'status'
  const arg = process.argv[3]
  const now = nowSec()
  const ownCollection = (): string => {
    const row = db.query('SELECT address FROM collections WHERE creator = ? ORDER BY created_block DESC LIMIT 1').get(lc(r1.address)) as { address: string } | null
    if (!row) throw new Error('No rival collection indexed yet. Run seed, then wait for the worker to index it.')
    return row.address
  }

  switch (cmd) {
    case 'seed': {
      const { seed, commitment } = RivalBot.newSeed()
      mkdirSync(dirname(SEED_FILE), { recursive: true })
      writeFileSync(SEED_FILE, JSON.stringify({ seed, commitment }), { mode: 0o600 })
      const params = [
        'Rival Apes', 'RAPE', '1000000', 20, 8, now - 60, r1.address, 500, 'https://example.invalid/rival-apes/', commitment, now + 7 * 86_400,
      ]
      await bot.call(r1, env.factory, CREATE_COLLECTION_SIG, [params], `seed:create:${now}`)
      console.log('collection created; waiting for the worker to index it...')
      return
    }
    case 'populate': {
      const collection = ownCollection()
      for (const r of [r1, r2]) {
        await bot.approveUsdc(r, collection, 8_000_000n, `pop:approve:${r.label}`)
        await bot.call(r, collection, 'mint(uint32)', ['8'], `pop:mint:${r.label}`)
        await bot.call(r, collection, 'setApprovalForAll(address,bool)', [env.market, true], `pop:setapproval:${r.label}`)
      }
      console.log('rivals minted 8 tokens each and approved the market')
      return
    }
    case 'list': {
      const collection = ownCollection()
      const mine = (r: RivalWallet) =>
        (db.query('SELECT token_id FROM tokens WHERE collection = ? AND owner = ? ORDER BY CAST(token_id AS INTEGER)').all(collection, lc(r.address)) as Array<{ token_id: string }>).map((x) => x.token_id)
      const base = parseUsdc(arg ?? '1.600')
      let i = 0
      for (const [r, ids] of [[r1, mine(r1).slice(0, 3)], [r2, mine(r2).slice(0, 3)]] as Array<[RivalWallet, string[]]>) {
        for (const id of ids) {
          const price = base + BigInt(i++) * PRICE_TICK * 20n
          await bot.call(r, env.market, 'list(address,uint256,uint256,uint64)', [collection, id, price.toString(), String(now + 86_400)], `list:${r.label}:${id}:${price}`)
        }
      }
      console.log('rival listings created')
      return
    }
    case 'undercut':
    case 'crash': {
      const collection = ownCollection()
      const agent = agentAddress(db)
      const current = activeListings(db, now, collection).filter((l) => lc(l.seller) !== agent)
      const mineIds = (db.query('SELECT token_id FROM tokens WHERE collection = ? AND owner = ?').all(collection, lc(r2.address)) as Array<{ token_id: string }>).map((t) => t.token_id)
      const agentAsk = activeListings(db, now, collection).filter((l) => lc(l.seller) === agent).sort((a, b) => (a.price < b.price ? -1 : 1))[0]
      let target: bigint
      if (cmd === 'crash') target = parseUsdc(arg ?? '1')
      else {
        if (!agentAsk) throw new Error('The agent has no active listing to undercut')
        target = agentAsk.price - PRICE_TICK * BigInt(arg ?? '1')
      }
      const own = current.find((l) => lc(l.seller) === lc(r2.address))
      const token = own?.tokenId ?? mineIds.find((id) => !current.some((l) => l.tokenId === id))
      if (!token) throw new Error('rival-2 has no token to list')
      const fn = own ? 'updateListing(address,uint256,uint256,uint64)' : 'list(address,uint256,uint256,uint64)'
      await bot.call(r2, env.market, fn, [collection, token, target.toString(), String(now + 86_400)], `${cmd}:${token}:${target}:${now}`)
      console.log(`rival-2 listed #${token} at ${Number(target) / 1e6} USDC`)
      return
    }
    case 'bid': {
      const collection = ownCollection()
      const price = parseUsdc(arg ?? '1.000')
      await bot.approveUsdc(r1, env.market, price * 10n, `bid:approve:${now}`)
      await bot.call(r1, env.market, 'makeOffer(address,uint256,bool,uint256,uint64)', [collection, '0', true, price.toString(), String(now + 3600)], `bid:${price}:${now}`)
      console.log(`rival-1 bid ${Number(price) / 1e6} USDC on any token`)
      return
    }
    case 'outbid': {
      const collection = ownCollection()
      const agent = agentAddress(db)
      const others = activeOffers(db, now, collection).filter((o) => o.collectionWide && lc(o.bidder) !== lc(r1.address) && lc(o.bidder) !== agent)
      const agentOffer = activeOffers(db, now, collection).find((o) => lc(o.bidder) === agent)
      const topOther = [...others, ...(agentOffer ? [agentOffer] : [])].reduce<bigint>((m, o) => (o.price > m ? o.price : m), 0n)
      const mine = activeOffers(db, now, collection).find((o) => lc(o.bidder) === lc(r1.address))
      const target = topOther + PRICE_TICK * BigInt(arg ?? '1')
      if (!mine) throw new Error('rival-1 has no active offer: run bid first')
      await bot.approveUsdc(r1, env.market, target * 10n, `outbid:approve:${now}`)
      await bot.call(r1, env.market, 'updateOffer(uint256,uint256,uint64)', [String(mine.offerId), target.toString(), String(now + 3600)], `outbid:${mine.offerId}:${target}:${now}`)
      console.log(`rival-1 raised its offer to ${Number(target) / 1e6} USDC`)
      return
    }
    case 'buy': {
      const collection = ownCollection()
      const buyer = arg === 'r2' ? r2 : r1
      const tokenId = process.argv[4]
      if (!tokenId) throw new Error('usage: agent:rivals buy <r1|r2> <tokenId>')
      const listing = activeListings(db, now, collection).find((l) => l.tokenId === tokenId)
      if (!listing) throw new Error(`token #${tokenId} has no active listing`)
      if (lc(listing.seller) === lc(buyer.address)) throw new Error('a rival cannot buy its own listing')
      await bot.approveUsdc(buyer, env.market, listing.price * 2n, `buy:approve:${tokenId}:${now}`)
      await bot.call(buyer, env.market, 'buy(address,uint256,uint256)', [collection, tokenId, listing.price.toString()], `buy:${tokenId}:${listing.price}:${now}`)
      console.log(`${buyer.label} bought #${tokenId} at ${Number(listing.price) / 1e6} USDC (synthetic sale, tagged as such in the dashboard)`)
      return
    }
    case 'relist': {
      const collection = ownCollection()
      const owner = arg === 'r2' ? r2 : r1
      const tokenId = process.argv[4]
      const price = process.argv[5]
      if (!tokenId || !price) throw new Error('usage: agent:rivals relist <r1|r2> <tokenId> <price>')
      const existing = activeListings(db, now, collection).find((l) => l.tokenId === tokenId && lc(l.seller) === lc(owner.address))
      const fn = existing ? 'updateListing(address,uint256,uint256,uint64)' : 'list(address,uint256,uint256,uint64)'
      await bot.call(owner, env.market, fn, [collection, tokenId, parseUsdc(price).toString(), String(now + 86_400)], `relist:${tokenId}:${price}:${now}`)
      console.log(`${owner.label} ${existing ? 'repriced' : 'listed'} #${tokenId} at ${price} USDC`)
      return
    }
    case 'reveal': {
      const collection = ownCollection()
      const { seed } = JSON.parse(readFileSync(SEED_FILE, 'utf-8')) as { seed: string }
      await bot.call(r1, collection, 'reveal(bytes32)', [seed], `reveal:${collection}`)
      console.log('traits revealed')
      return
    }
    default: {
      const agent = agentAddress(db)
      console.log('rivals:', rivals.map((r) => `${r.label}=${r.address}`).join(' '))
      console.log('agent:', agent)
      console.log('chain:', chainFacts.name)
    }
  }
}

main().catch((e: unknown) => {
  console.error('rivals failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
