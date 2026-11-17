# Read-only OpenSea data adapter

The adapter requests public marketplace data from OpenSea API v2 using server-side `OPENSEA_API_KEY`. It supports collection details and lists, NFT metadata, floor-price history, collection statistics, search, top/trending rankings, and activity feeds. Requests are restricted to a fixed OpenSea HTTPS host and `GET`; pagination uses OpenSea's cursor-shaped `next` query parameter. Only read responses pass through this component.

## Security boundary

- This adapter does not import or call wallet, RPC, signing, order-submission, purchase, or transfer code.
- It does not expose an API-key field or echo the key in responses/logs. Configure the key in the server secret environment, never in the browser or a URL.
- There are no write routes. Every transaction-like method (`buy`, `sell`, `cancel`, `transfer`, `createListing`, `createOffer`) throws `NotImplementedException`.
- The current `agent/src/exec/policy.ts` remains untouched. Arc Testnet's existing signing allowlist is not broadened.
- This integration is a read-only data provider, not a marketplace trading adapter. API provider access and schemas can change; consult current official OpenSea docs before deployment.

## Run

Set `OPENSEA_API_KEY` in the worker's server-side environment and run `bun run agent:opensea-readonly`. The standalone read-only API proxy listens on port 8789 by default (`OPENSEA_READONLY_PORT` overrides it). Without a key, requests fail closed with 503. It does not require the production trading worker, Circle credentials, RPC access, or a connected wallet.

## Read-only routes

- `GET /collections?chain=ethereum&limit=20&cursor=...`
- `GET /collections/{slug}`
- `GET /collections/{slug}/stats`
- `GET /collections/{slug}/floor_prices?limit=20&cursor=...`
- `GET /nfts?chain=ethereum&contract=0x...&limit=20&cursor=...`
- `GET /nfts/{chain}/{contract}/{identifier}`
- `GET /search?query=...&chain=ethereum&limit=20&cursor=...` (repeat `chain` for multiple filters)
- `GET /rankings/top?chain=ethereum&limit=20&cursor=...`
- `GET /rankings/trending?chain=base&limit=20&cursor=...`
- `GET /activity?collection={slug}&event_type=sale&after={unix}&before={unix}&limit=20&cursor=...`

All non-GET requests return 405 without contacting OpenSea. The adapter restricts paging to 1–50 results and validates chain, collection, contract, and NFT path components. OpenSea error statuses are surfaced without response bodies or credentials; `Retry-After` is relayed for rate limits.

## Architecture

```text
HTTP GET routes (:8789)
      |
      v
OpenSeaReadOnlyAdapter -- fixed-host HTTPS GET + backend API key --> api.opensea.io/api/v2
      |
      +-- DTOs: collection, stats, floor history, NFT metadata, search, rankings, activity
      +-- buy/sell/cancel/transfer/listing/offer methods --> NotImplementedException

Production worker, Arc-only signing policy, and execution pipeline: separate and unchanged
```

## TODO: future marketplace integrations (disabled)

- TODO: Keep this provider read-only unless a future request explicitly authorizes a separate trading integration.
- TODO: Validate every current endpoint, filter, response schema, rate limit, and network slug against the official OpenSea API reference before deployment.
- TODO: Add runtime schema validation/versioning and safe caching if required by the product.
- TODO: Review API-key provisioning, rotation, quotas, and data usage terms with deployment operators.
- TODO: Any future signing or trade adapter requires a distinct threat model, wallet design, policy review, chain-specific testing, explicit authorization, and must not be added to this read-only adapter.
