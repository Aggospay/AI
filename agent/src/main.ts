/**
 * Worker entry point. Runs the indexer, scheduler, strategies and control plane in one process.
 * Safe to kill and restart at any time: all state is in SQLite and the indexer resumes from its cursor.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from './app'
import { chainFacts, makeClient } from './chain/clients'
import { ARC_TESTNET_CHAIN_ID, loadEnv } from './config'
import { logActivity, openDb } from './db'
import { logger } from './log'
import { startServer } from './server'
import { errMessage } from './util'

const log = logger('main')

async function main() {
  const startedAt = Date.now()
  const env = loadEnv(chainFacts.rpcUrls)
  if (!process.env.AGENT_ADMIN_TOKEN) {
    // First boot: create an admin token and store it in .env. It is never printed.
    const token = randomBytes(24).toString('hex')
    appendFileSync(join(process.cwd(), '.env'), `\nAGENT_ADMIN_TOKEN=${token}\n`, 'utf-8')
    process.env.AGENT_ADMIN_TOKEN = token
    env.adminToken = token
    log.info('Created AGENT_ADMIN_TOKEN and saved it to .env (open the file to copy it into the dashboard)')
  }

  const db = openDb(env.dbPath)
  const client = makeClient(env)
  const chainId = await client.getChainId().catch((e: unknown) => {
    throw new Error(`RPC unreachable: ${errMessage(e)}`)
  })
  if (chainId !== ARC_TESTNET_CHAIN_ID) throw new Error(`RPC reports chain ${chainId}, expected ${ARC_TESTNET_CHAIN_ID}. Refusing to start.`)

  const app = createApp(db, env, client)
  if (!env.market || !env.factory) log.warn('VITE_FACTORY_ADDRESS / VITE_MARKET_ADDRESS not set: the agent will idle until contracts are deployed')
  await app.ctx.gas.refresh(0).catch((e: unknown) => log.warn('gas price unavailable at boot', { error: errMessage(e) }))
  app.ctx.exec.recover()
  logActivity(db, { strategy: 'system', message: `Worker started in ${app.getSettings().mode} mode (${app.getSettings().approvalMode} approval)` })

  app.registerTasks()
  const indexerDone = app.ctx.indexer.run()
  const server = startServer({ app, db, env, startedAt })

  const shutdown = (signal: string) => {
    log.info(`${signal} received, shutting down`)
    app.scheduler.stop()
    app.ctx.indexer.stop()
    server.stop()
    void indexerDone.finally(() => {
      db.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: errMessage(e) }))
}

main().catch((e: unknown) => {
  log.error('fatal', { error: errMessage(e) })
  process.exit(1)
})
