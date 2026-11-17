# Mock marketplace adapter

This isolated subsystem is **mock-only**. It imports no production execution, policy, wallet, chain, RPC, or signing modules. OpenSea-like REST field names are used only as local DTO inspiration; there are no OpenSea API calls or credentials.

## Architecture

```text
HTTP example routes (standalone, :8788)
             |
             v
 MockListingService ---- MockOrderService
             \              /
              v            v
       MarketplaceAdapter (read + local mock outcomes)
                      |
                      v
       OpenSeaMockAdapter (no-op action results)
                      |
                      v
       InMemoryMarketplaceRepository
       collections / NFTs / listings / orders

 Production server and Arc signing policy  [separate; untouched]
```

## Run and try

`bun run agent:mock-market` launches the standalone mock API on port 8788 by default (`MOCK_MARKET_PORT` changes the port). It does not initialize the production worker or connect to a wallet or RPC.

Example endpoints:

- `GET /networks`
- `GET /collections?chain=ethereum`
- `GET /collections/mock-creatures?chain=base`
- `GET /nfts/0x0000000000000000000000000000000000000abc/1?chain=ethereum`
- `GET /listings?chain=ethereum&collection=mock-creatures&minPrice=0.3&sortBy=price&direction=asc&limit=2&cursor=2`
- `GET /orders?chain=base&side=offer&status=active`
- `POST /orders` with a mock order draft JSON body (stored locally in memory only)
- `POST /actions/buy`, `/actions/sell`, `/actions/cancel`, `/actions/transfer` return explicitly rejected mock results; no state or asset is changed

Network names are fixture adapter keys, not a claim about current OpenSea network availability. The repository can be constructed with any explicit list of mock network IDs.

## Future integration TODOs (disabled)

- TODO: Verify official marketplace API schemas and per-chain support before building a live read adapter.
- TODO: Add chain-specific Seaport/order terms and fulfillment only after independent contract and signing-policy review.
- TODO: Add wallet execution only in a separately reviewed module; this mock package must never import it.
- TODO: Add durable, chain-scoped repositories and reorg/idempotency handling for a live integration.
- TODO: Validate token decimals, payment tokens, fee/royalty settlement and native gas valuation per network.
- TODO: Add rate-limit, API-key, data retention and provider compliance review before any API client exists.
- TODO: Keep `agent/src/exec/policy.ts` as the signing authority and require a separate security review before changing it.

No TODO above is implemented by this package. The current Arc-only signing policy and production transaction paths are unchanged.
