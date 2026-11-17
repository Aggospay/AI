# NFT Trading Agent

An autonomous NFT trading agent for Arc Testnet with a live control dashboard. It watches a test NFT marketplace, scores collections, mints and buys only when expected net profit clears your limits, and keeps a durable history of orders and outcomes.

Built with [Arc Studio](https://studio.arc.io)

## What it does

* Tracks collections, listings, offers and sales in real time and rejects wash-traded or manipulated prices.
* Calculates net profit after marketplace fees, royalties and gas before every action. A cheap price alone never triggers a purchase.
* Lists held tokens one tick under the lowest comparable listing, follows competitors down, stops at the minimum profitable price, and raises the price when the market improves.
* Bids on collections up to the highest profitable price and counters rivals by the smallest sensible step.
* Enforces your limits: maximum prices, daily and weekly spend, per-collection exposure, liquidity, collection score, allow and block lists, and a global pause.
* Manual approval mode and fully automated mode, per-strategy switches and an emergency stop.
* Dashboard: portfolio value, realized and unrealized profit, gas and fees, opportunities, launches, listings, offers, approvals, activity and alerts.
* Language selector in the dashboard: English, Chinese, Indonesian, Hindi, Spanish, Arabic (right-to-left) and Russian.

Predictive floors, cross-marketplace arbitrage, whale tracking, adaptive pricing, strategy optimization, AI research, trait offers, and multi-chain trading are not yet implemented. Chain-aware RPC selection is groundwork only; see `docs/MULTICHAIN.md` for the live safety boundary and rollout requirements.

## Tech stack

React, Vite, TypeScript, Tailwind CSS, wagmi, viem, ConnectKit. Solidity with Foundry. A Bun worker with SQLite. Circle developer-controlled wallets for signing.

## Development

Prerequisites: Bun, Foundry.

```bash
bun install
bun run dev            # dashboard on port 5173
bun run agent:start    # worker on port 8787 (the dashboard proxies /api to it)
```

Run the checks and tests:

```bash
bun run check          # lint and typecheck
bun run agent:test     # worker tests
bun run agent:smoke    # API checks against a running worker
bun run agent:ui-check # renders every dashboard tab in every language against a running worker
bun run contracts:test # contract tests
```

Docs: `docs/WALLET_SETUP.md`, `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `docs/MULTICHAIN.md`.

## Environment variables

| Name | Purpose |
| --- | --- |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | Arc Testnet live execution only |
| `AGENT_ADMIN_TOKEN` | Token the dashboard uses; created on first start if missing |
| `AGENT_CHAIN_ID` | Chain facts ID; defaults to Arc Testnet (5042002). Non-Arc is RPC/read-only groundwork only |
| `AGENT_PORT` | Worker port, default 8787 |
| `AGENT_DB_PATH` | SQLite file location |
| `AGENT_START_BLOCK` | Arc Testnet block the indexer starts from |
| `AGENT_WS_URL` | Optional Arc Testnet WebSocket endpoint |
| `AGENT_PAPER_BALANCE` | Starting balance for paper trading, in USDC base units |
| `VITE_FACTORY_ADDRESS`, `VITE_MARKET_ADDRESS` | Arc Testnet deployed contract addresses only |
| `RPC_URL_Arc_Testnet` | Your Arc Testnet RPC endpoint |
| `RPC_URL_Ethereum`, `RPC_URL_Base` | Optional chain-specific RPC endpoints; public facts endpoints are fallback |
| `AGENT_FACTORY_ADDRESS_<chainId>`, `AGENT_MARKET_ADDRESS_<chainId>` | Optional chain-scoped addresses; only set after compatible deployment and independent review |
| `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` | Optional Arc Studio RPC proxy settings |
