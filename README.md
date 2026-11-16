# NFT Trading Agent

An autonomous NFT trading agent for Arc Testnet with a live control dashboard. It watches a test NFT marketplace, scores collections, mints and buys only when expected net profit clears your limits, lists what it holds just below the lowest comparable competitor without ever selling below its minimum profitable price, manages offers, and tracks portfolio performance. Paper trading is the default. Mainnet is not supported.

Built with [Arc Studio](https://studio.arc.io)

## What it does

* Tracks collections, listings, offers and sales in real time and rejects wash-traded or manipulated prices.
* Calculates net profit after marketplace fees, royalties and gas before every action. A cheap price alone never triggers a purchase.
* Lists held tokens one tick under the lowest comparable listing, follows competitors down, stops at the minimum profitable price, and raises the price when the market improves.
* Bids on collections up to the highest profitable price and counters rivals by the smallest sensible step.
* Enforces your limits: maximum prices, daily and weekly spend, per-collection exposure, liquidity, collection score, allow and block lists, and a global pause.
* Manual approval mode and fully automated mode, per-strategy switches and an emergency stop.
* Dashboard: portfolio value, realized and unrealized profit, gas and fees, opportunities, launches, listings, offers, approvals, activity and alerts.
* Language selector in the dashboard: English, Chinese, Indonesian, Hindi, Spanish, Arabic (right-to-left) and Russian. Your choice is remembered in the browser. Technical text produced by the agent (activity messages, score notes, reasons) stays in English.

Features from the original spec that are not built (predictive floors, cross-marketplace arbitrage, whale tracking, adaptive pricing, AI research, trait offers, Ethereum and Base) are listed inside the dashboard.

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

Docs: `docs/WALLET_SETUP.md`, `docs/DEPLOYMENT.md`, `docs/ARCHITECTURE.md`.

### Environment variables

| Name | Purpose |
| --- | --- |
| `CIRCLE_API_KEY` | Circle API key for the agent wallet (needed for live testnet trading) |
| `CIRCLE_ENTITY_SECRET` | Circle entity secret registered for the account |
| `AGENT_ADMIN_TOKEN` | Token the dashboard uses to talk to the worker (created on first start) |
| `AGENT_PORT` | Worker port, default 8787 |
| `AGENT_DB_PATH` | SQLite file location |
| `AGENT_START_BLOCK` | Block the indexer starts from (the factory deployment block) |
| `AGENT_WS_URL` | Optional WebSocket endpoint for faster head notifications |
| `AGENT_PAPER_BALANCE` | Starting balance for paper trading, in USDC base units |
| `AGENT_LOG_LEVEL` | `debug`, `info`, `warn` or `error` |
| `AGENT_DASHBOARD_DIR` | Optional folder with the built dashboard for the worker to serve |
| `VITE_FACTORY_ADDRESS`, `VITE_MARKET_ADDRESS` | Deployed contract addresses (public) |
| `RPC_URL_Arc_Testnet` | Your own RPC endpoint for Arc Testnet (recommended for 24/7) |
| `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS` | Provisioned by Arc Studio. Optional elsewhere |
