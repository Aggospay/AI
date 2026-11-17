import { handleOpenSeaReadOnlyRequest } from './opensea-readonly-routes'

const port = Number(process.env.OPENSEA_READONLY_PORT ?? 8789)
Bun.serve({
  port,
  async fetch(request) {
    return handleOpenSeaReadOnlyRequest(request)
  },
})
console.log(`OpenSea API read-only proxy listening on :${port}. GET only; no wallets or transactions.`)
