import { handleMockMarketplaceRequest } from './routes'

const port = Number(process.env.MOCK_MARKET_PORT ?? 8788)
Bun.serve({
  port,
  async fetch(request) {
    return handleMockMarketplaceRequest(request)
  },
})
console.log(`Mock marketplace API listening on :${port}. No blockchain or wallet connections are made.`)
