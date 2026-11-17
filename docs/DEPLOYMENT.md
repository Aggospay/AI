# Running the agent 24/7

Arc Studio's sandbox only runs while your session is active, so it is a development environment, not a host. For continuous operation run the worker on an always-on machine.

## What you need

* A host that keeps one process running and has a **persistent disk** for the SQLite file.
* Outbound HTTPS to Circle's API and Arc Testnet RPC for live testnet use. Use a dedicated RPC provider URL (`RPC_URL_Arc_Testnet`) for reliable operation.
* Secrets in the host's secret store: `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `AGENT_ADMIN_TOKEN`. Everything else is public configuration (see `agent/.env.example`).
* Optional: `AGENT_WS_URL` for Arc Testnet head notifications over WebSocket. Without it the indexer polls every second.

## Steps

1. Deploy the contracts and note the factory address, market address and the factory's deployment block.
2. Copy `agent/.env.example` into your host's configuration and fill in `VITE_FACTORY_ADDRESS`, `VITE_MARKET_ADDRESS`, `AGENT_START_BLOCK`.
3. Copy the SQLite database if you want to keep wallet registrations, or run `bun run agent:setup wallets` against the same Circle account.
4. Start: `bun run agent:start`, or build the image from `agent/Dockerfile`.
5. Optional dashboard hosting from the worker: run `bun run build`, copy `dist/` next to the worker, and open the worker's port.
6. Health: `GET /healthz` returns 200 only while the indexer has synced within two minutes. Back up the SQLite file regularly.

## Chain support status

RPC clients use the selected chain's facts. Arc Testnet remains the only chain with a reviewed market deployment, gas-to-USDC conversion, and Circle live execution. Ethereum, Base, and other chains with USDC facts are connectivity/read-only groundwork only; keep strategy execution in paper mode and do not set Arc deployment addresses for them. See `docs/MULTICHAIN.md` before configuring another chain.

## Not tested

The Dockerfile has not been built and no deployment to an external host has been run. Verify restart recovery on your host before relying on it.
