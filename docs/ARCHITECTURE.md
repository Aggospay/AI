# Architecture

## What exists

| Layer | Where | Status |
| --- | --- | --- |
| Marketplace and collection contracts | `contracts/` | Written, reviewed, 157 Foundry tests pass |
| Worker (indexer, analysis, risk, execution, strategies, API) | `agent/src/` | 102 Bun tests pass in paper mode against a simulated chain; live scenarios on Arc Testnet are listed in `docs/TESTING.md` |
| Dashboard | `src/` | Built, typechecked. Served the live API through the preview proxy; not clicked through end to end by the author |
| Circle signing path | `agent/src/exec/circle.ts` | Exercised live on Arc Testnet: approvals, mint, buy, list, update, offers, accept, cancel |
| Rival simulator | `agent/src/rivals/` | Run live: seed, populate, list, undercut, crash, bid, outbid, buy |

## Data flow

```
Arc Testnet RPC (several URLs, failover) --getLogs from a persisted cursor--> Indexer --> SQLite projections
        ^ head notifications (WebSocket if configured, else polling)                          |
                                                                                              v
Scheduler tasks + head/market events --> Strategies (deterministic) --> Risk gate --> Intent (SQLite) --> Executor
                                                                                              |            |-- Paper (simulated)
                                                                                              |            `-- Circle developer-controlled wallet
Dashboard <--REST + SSE-- control plane <---------------------------------------------------- `--> tx tracking --> ledger
```

* **Deterministic hot path.** Pricing, bidding, buying and risk decisions are plain functions. No language model is called for any price update or transaction. The AI/research layer is not implemented (see the stub list in the dashboard).
* **One writer.** The worker is the only process that writes agent state. The rival script only reads the database.
* **Recoverable.** Indexer cursor, intents, spend, tasks and settings live in SQLite. On restart the worker resumes the cursor, re-runs claimed-but-unsent intents with the same idempotency key, and resumes tracking in-flight transactions.
* **No duplicate execution.** Every action has an idempotency key. An intent can only move `approved -> pending` once (compare-and-set). Circle receives a deterministic idempotency key derived from the intent key. Mints are additionally capped per wallet by the contract.

## Contracts

* `ArcCollection`: ERC-721 + ERC-2981. Immutable terms, no owner. Traits come from a committed seed revealed only after sell-out or mint end, so minters cannot cherry-pick.
* `CollectionFactory`: permissionless creation, registers collections. The market only trades registered collections.
* `NftMarket`: fixed-price listings (tokens stay in the seller's wallet), token offers and collection-wide offers with USDC escrow, 0.001 USDC price tick, owner-set fee (capped at 10%), royalties accrued and withdrawn separately, pausable (cancellations and refunds always work), ownership cannot be renounced.

Trait offers are not supported by the contract.

## Execution safety

* The agent can only sign calls built in `agent/src/exec/policy.ts`: fixed contracts, fixed function signatures, parameters validated against indexed state. Approvals only ever target the market, and USDC allowances are capped by the exposure limit. There is no code path for arbitrary calldata, message signing or typed-data signing.
* The risk gate (`agent/src/risk/engine.ts`) must pass before an intent exists. Global pause, mode and expiry are checked again immediately before anything is sent.
* Live buys carry `maxPrice`, offer acceptances carry `minPrice`: the contract enforces the price the decision was made at.
* Before buying, the worker re-reads the listing, owner and approval from the chain instead of trusting the index.

## Anti-manipulation

Fair value uses only independent sales. Excluded: self trades, trades between wallets registered to the same operator, A to B to A round trips within 24 hours, and statistical outliers. Simulated rival wallets are excluded too, unless the test-harness switch is on (in which case the UI says all such data is synthetic). The agent never buys from or sells to wallets registered to the same operator unless that same switch is on.

## Adding a marketplace or chain

Implement the read side (listings, offers, sales, floor) and write side (list, buy, bid) behind new modules, add them to the allowlist in `policy.ts`, and extend `SUPPORTED_CHAIN_IDS` only after an independent review. No other marketplace adapter is built or tested.
