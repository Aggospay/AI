## Implementation Plan: Arc Autonomous NFT Trading Agent

### Summary
A 24/7 NFT trading agent that runs as a standalone Bun backend worker with SQLite state, plus a React control dashboard. It trades on a marketplace and mintable collections that we deploy to Arc Testnet. It runs a deterministic loop: discover, score, mint or buy, list, undercut, manage offers, track the portfolio and enforce risk limits. Simulated rival traders compete with it, so undercutting and bidding can be tested.

### Architecture

**What is and isn't in scope (stated up front):**
- Arc Studio is testnet-only. OpenSea, Blur, Magic Eden, Reservoir, Ethereum mainnet and Base mainnet are NOT integrated, and the code will refuse any chain except Arc Testnet.
- The agent talks to the market through a `MarketAdapter` interface. The only adapter built and tested is our own Arc marketplace. Other chains and marketplaces would be new adapters later, and nothing will claim they work.
- Predictive floors, cross-marketplace arbitrage, whale monitoring, adaptive pricing, strategy optimization and LLM research are documented stubs. Each is a typed interface that returns "not implemented", and the dashboard labels it that way.
- Social, team and community data has no real source. Those scoring components are marked "unscored", and the score is normalized over the components that have data, with a minimum-coverage gate.

**Blockchain:** Arc Testnet (chain ID 5042002). USDC is the trading currency and also pays gas. All amounts are bigint in the 6-decimal USDC view. Native gas math uses 18 decimals and is converted once (/1e12, rounded up). Chain facts come from `@/onchain-facts` and money parsing from `@/onchain-money`.

**Contracts** (Solidity 0.8.28, Foundry, OpenZeppelin 5.6.1; reviewed and fork-tested before deploy):
- `ArcCollection`: ERC-721 with ERC-2981 royalty. It has a public mint paid in USDC, with `mintStart`, `maxSupply`, per-wallet cap and mint price. Traits are packed at mint and emitted in a `Minted` event, which feeds rarity ranking. Traits come from onchain pseudo-randomness, which is fine for a testnet fixture and not a production design.
- `CollectionFactory`: deploys collections and emits `CollectionCreated`. Collections from the factory are the verified set the agent will mint from or buy.
- `NftMarket` (USDC, reentrancy-guarded, pausable):
  - Fixed-price listings: `list`, `updateListing`, `cancelListing`, `buy(maxPrice)`. Listings don't escrow the NFT. Buy checks ownership and approval.
  - Token offers and collection-wide offers, with USDC escrowed in the contract: `makeOffer`, `updateOffer`, `cancelOffer`, `acceptOffer`, `acceptCollectionOffer`, and expiry reclaim.
  - Prices must be multiples of `PRICE_TICK` (0.001 USDC). The marketplace fee is in bps with a hard cap, and royalties are paid via ERC-2981.
  - Trait offers are not supported onchain. The dashboard shows them as unsupported.
  - Every state change emits an event for the indexer.

**Backend worker** (`agent/`, Bun + TypeScript, `bun:sqlite`, single-writer process):
- Indexer: fault-tolerant provider failover and WebSocket log subscriptions, with `getLogs` backfill from a persisted block cursor on every boot. Events are stored idempotently by `(txHash, logIndex)` and reduced into projections (tokens, listings, offers, sales, holders, rarity). Reconnect with backoff.
- Valuation: fair value from independent recent sales, with outlier rejection (median/MAD) and staleness limits. Wash filter excludes self-trades, trades between related wallets, A->B->A round trips and simulated-fixture trades. Rarity premium comes from trait frequency.
- Profit calculator: a pure bigint function, unit-tested. `Net = expected proceeds - acquisition (or mint) - gas (buy, approve, list, sell) - marketplace fee - royalty - other costs`. It also returns ROI, expected holding period and a liquidity score. It computes `minProfitablePrice = ceil_to_tick((cost + gas + other + minNetProfit) / (1 - feeBps - royaltyBps))`.
- Risk engine: a single gate that every action must pass before execution. It enforces max mint, purchase and gas price; min net profit and min ROI; daily and weekly spend caps; per-collection exposure and token count; min liquidity; stale-price and manipulation checks; allowlist and blocklist; collection score threshold; contract verification (factory-created, bytecode hash match); and a global pause.
- Strategies (deterministic, no LLM in the hot path):
  - Scanner and buyer: rank listings by net profit and buy only when every gate passes. Cheap alone never qualifies.
  - Lister and repricer: target = `max(minProfitablePrice, lowestComparableCompetitor - undercutTicks*tick)`. Comparable means the same rarity band. It ignores the agent's own listings. It never goes below the minimum profitable price; when a competitor goes lower, it holds at the minimum and waits. It raises the price when the market improves. It uses cooldowns, a max-changes-per-hour limit and a minimum change size, with backoff to avoid price wars.
  - Offer manager: `maxBid` comes from the profit calculator. Target = `bestRivalOffer + tick`, capped at `maxBid`, with no self-bidding. It lowers a bid when competition drops, cancels pointless offers, renews before expiry, and tracks committed capital. It keeps token, collection and (unsupported) trait offers separate.
  - Mint sniper: watches `CollectionCreated` and new block timestamps. Before `mintStart` it pre-checks the contract, score, price and cap, and sets a capped USDC allowance. It fires once on the first eligible block. A unique DB key plus the onchain per-wallet cap prevents duplicate mints. A new collection with no secondary data has no verifiable resale value, so it becomes a manual-approval proposal instead of an auto-mint.
  - Portfolio manager: marks each position as hold, reprice, sell or delist. Tracks realized and unrealized P&L, gas, fees, and allocation limits.
- Collection scoring: a deterministic 0-100 score with weights matching your example. Components are computed from onchain data only (contract/security, mint economics, liquidity, demand, rarity, holder concentration). Unscored components are shown as such.
- Execution layer: an intent is persisted with an idempotency key before sending, so duplicates are impossible and restarts recover pending intents. A tx tracker polls to a terminal state (`@/onchain-wait`) and handles stuck transactions, with retries only where safe. An `Executor` interface has two implementations: `PaperExecutor` (simulates fills, default) and `CircleExecutor`. The CircleExecutor signs with a Circle developer-controlled wallet via `createContractExecutionTransaction`, using a hardcoded allowlist: market and collection functions, and USDC `approve` only to the market or a collection with a capped amount. It cannot sign arbitrary calls or messages. The key never leaves Circle's custody. Circle API round-trip latency is slower than local signing; Arc's instant finality helps, but the plan does not promise block-level sniping.
- Modes: `paper` (default) and `testnet-live`. Switching needs a typed confirmation. Manual approval creates pending proposals; auto mode executes. Each strategy (mint, buy, list, offers) has its own toggle.
- Control plane: a Bun HTTP server provides REST plus an SSE stream, `/healthz`, and control endpoints that need `AGENT_ADMIN_TOKEN`. Emergency stop halts everything immediately. A "panic" option also cancels open offers and optionally delists.
- Rival simulator (`agent/src/rivals`): 2-3 separate Circle wallets that mint, list, undercut and bid with scripted behaviors. Rival wallets are labeled `fixture` in a wallet registry. The agent refuses to trade with them by default. A visible "test harness" toggle allows it on testnet only, and those trades are tagged synthetic and excluded from fair value and performance stats. Undercut and offer scenarios are tested without wash trades, because the agent can undercut and out-bid rivals without ever selling to them.

**Frontend** (React 18, Vite, Tailwind, wagmi + ConnectKit): the dashboard reads the worker via a Vite `/api` proxy. It follows the Arc/Circle frontend direction. Your connected wallet is only used to send test USDC to the agent wallet and to show ownership. It never signs trades.

**Wallet:** ConnectKit for your wallet. The agent trades from a separate Circle developer-controlled EOA on Arc Testnet.

### Files to Create/Modify
1. `contracts/ArcCollection.sol`: ERC-721 + ERC-2981 collection with timed USDC mint and packed traits.
2. `contracts/CollectionFactory.sol`: deploys collections and emits the discovery event.
3. `contracts/NftMarket.sol`: listings, token and collection offers (escrowed), fees and royalties, price tick, pause.
4. `contracts/test/ArcCollection.t.sol`, `contracts/test/NftMarket.t.sol`: unit and fuzz tests for fees, royalties, escrow, expiry and tick rules.
5. `src/contracts.ts`: deployed addresses and ABIs, shared by the dashboard and worker.
6. `agent/src/config.ts`: validated settings schema with safe defaults. Paper mode, Arc Testnet only.
7. `agent/src/db/schema.ts`, `agent/src/db/index.ts`: SQLite schema, migrations, and the intent, task, cursor and event tables.
8. `agent/src/chain/clients.ts`: multi-RPC fallback, WebSocket subscriptions and health scoring.
9. `agent/src/chain/indexer.ts`: backfill, live logs and the idempotent event reducer.
10. `agent/src/market/adapter.ts`: `MarketAdapter` interface. `agent/src/market/arcMarket.ts` is the Arc implementation.
11. `agent/src/analysis/valuation.ts`: fair value, wash filter, rarity ranking.
12. `agent/src/analysis/profit.ts`: pure bigint profit and min-price calculator.
13. `agent/src/analysis/scoring.ts`: 0-100 collection score with unscored components and coverage gate.
14. `agent/src/risk/engine.ts`: the pre-trade gate, limits, pause state and spend accounting.
15. `agent/src/strategies/scanner.ts`, `buyer.ts`, `repricer.ts`, `offers.ts`, `mintSniper.ts`, `portfolio.ts`: deterministic strategy modules.
16. `agent/src/exec/executor.ts`: `Executor` interface, idempotent intent queue and tx tracker.
17. `agent/src/exec/paperExecutor.ts`, `agent/src/exec/circleExecutor.ts`: simulated and Circle-signed execution with the call allowlist.
18. `agent/src/rivals/rivals.ts`: scripted rival behaviors and the wallet registry.
19. `agent/src/ai/stubs.ts`: typed "not implemented" interfaces for predictive floor, cross-market arbitrage, whale monitoring, adaptive pricing, strategy optimization, LLM research.
20. `agent/src/server.ts`: REST, SSE, `/healthz`, admin auth.
21. `agent/src/main.ts`: boot, recovery, scheduler and graceful shutdown.
22. `agent/test/*.test.ts`: profit, undercut ladder, offer manager, risk gates, wash filter, idempotency and restart recovery, indexer replay.
23. `scripts/deploy-market.ts`: deploys the factory and market, and seeds a demo collection and rival wallets.
24. `src/App.tsx`: dashboard shell, routing and API client.
25. `src/components/`: `Overview`, `Opportunities`, `Mints`, `Positions`, `Listings`, `Offers`, `ActivityLog`, `RiskControls`, `Settings`, `ApprovalQueue`, `HealthBanner`, `FundAgent`.
26. `src/lib/api.ts`: typed fetch and SSE hook.
27. `vite.config.ts`: add the `/api` proxy to the worker. Also modify `package.json` (scripts `agent:dev`, `agent:start`, `agent:test`, `agent:rivals`; add `zod`), `.gitignore` (SQLite file, `.env*`, recovery files) and `src/main.tsx` / `src/config.ts` as needed.
28. `agent/Dockerfile`, `agent/.env.example`, `docs/DEPLOYMENT.md`, `docs/WALLET_SETUP.md`, `docs/ARCHITECTURE.md`: always-on deploy guide, wallet and credential setup, a "not implemented" table.

### Build Sequence
1. Credentials: provision Circle credentials and register the entity secret (testnet, with your confirmation). Create the wallet set with the agent wallet and 2-3 rival wallets. Fund them with test USDC.
2. Contracts: write the three contracts, run the security review and unit tests, run fork verification, then deploy to Arc Testnet. Record addresses in `src/contracts.ts`.
3. Worker foundation: config, SQLite schema, multi-RPC clients, indexer with backfill and reducer. Verify it replays events after a restart.
4. Analysis core: profit calculator, valuation and wash filter, scoring. Unit-test with fixed fixtures.
5. Risk engine and execution: the gate, intent queue, `PaperExecutor`, then `CircleExecutor` with the allowlist and tx tracker.
6. Strategies: scanner and buyer, then repricer, offer manager, mint sniper, portfolio manager.
7. Rival simulator and control plane: rivals, HTTP/SSE server, manual-approval queue, emergency stop.
8. Dashboard: build all views and controls, wire SSE, and show stubs as "not implemented".
9. Testing: run `forge test` and `bun test`. Then run live testnet scenarios: mint, buy, list, rival undercut, agent reprice, hold at the minimum profitable price, offer war to the cap, restart mid-flight, duplicate mint blocked, emergency stop. Record real pass/fail results.
10. Docs: write the deployment, wallet and architecture docs, including external infrastructure needed (always-on host, extra RPC providers, Circle API key). Say which items were validated and which weren't (for example, the Dockerfile if it isn't built here).

### Done When
- [ ] Contracts are deployed on Arc Testnet and all unit/fuzz tests pass.
- [ ] The worker indexes events live, backfills after restart and recovers pending intents without duplicate transactions.
- [ ] The profit calculator tests cover fee, royalty, gas and tick rounding, and no purchase or listing occurs below the minimum profitable price.
- [ ] The agent undercuts rival listings by one tick, ignores its own listings, stops at the minimum profitable price, and raises its price when the market improves.
- [ ] The offer manager counters rivals up to the configured maximum, never bids against itself and cancels or renews offers on expiry.
- [ ] A purchase is blocked by each risk limit: price, profit, ROI, spend caps, exposure, liquidity, stale or manipulated price, blocklist and low score.
- [ ] Mint sniper mints once per collection, and a second attempt is blocked.
- [ ] Wash-like trades are excluded from fair value, and simulated-fixture trades are tagged and excluded.
- [ ] Paper mode is the default. Switching to testnet-live needs explicit confirmation. Emergency stop halts execution immediately.
- [ ] No private key or secret appears in frontend code, logs or the browser. The executor rejects any call outside the allowlist.
- [ ] The dashboard shows live portfolio, opportunities, listings, offers, activity, failures, gas and alerts. It has working controls and a manual/auto mode toggle. Stub features are visibly labeled as not implemented.
- [ ] Deployment docs list the required external infrastructure and the exact steps. Everything not tested is stated as untested.

## Ready to build?
