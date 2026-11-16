# Running the agent 24/7

Arc Studio's sandbox only runs while your session is active, so it is a development environment, not a host. For continuous operation run the worker on an always-on machine.

## What you need

* A host that keeps one process running and has a **persistent disk** for the SQLite file (any VM or container platform).
* Outbound HTTPS to Circle's API and to an Arc Testnet RPC. A dedicated RPC provider URL (`RPC_URL_Arc_Testnet`) is strongly recommended: the public endpoint's limits are unknown and can throttle an indexer under load. Only the first working URL is used per call, extra URLs give failover.
* Secrets in the host's secret store: `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `AGENT_ADMIN_TOKEN`. Everything else is public configuration (see `agent/.env.example`).
* Optional: `AGENT_WS_URL` for head notifications over WebSocket. Without it the indexer polls every second.

## Steps

1. Deploy the contracts (done from Arc Studio) and note the factory address, market address and the factory's deployment block.
2. Copy `agent/.env.example` into your host's configuration and fill in `VITE_FACTORY_ADDRESS`, `VITE_MARKET_ADDRESS`, `AGENT_START_BLOCK`.
3. Copy `agent/data/agent.sqlite` to the host if you want to keep wallet registrations, or run `bun run agent:setup wallets` against the same Circle account (it reuses nothing, so copy the database instead of creating new wallets).
4. Start: `bun run agent:start`, or build the image from `agent/Dockerfile`.
5. Optional dashboard hosting from the worker: run `bun run build`, copy `dist/` next to the worker, and open the worker's port. The dashboard and API share one origin.
6. Health: `GET /healthz` returns 200 only while the indexer has synced within two minutes. Point your host's health check there. Back up the SQLite file regularly.

## Not tested

The Dockerfile has not been built and no deployment to an external host has been run. Treat both as a starting point and verify restart recovery on your host (kill the process while an action is in flight and confirm it resumes without a duplicate).

## Limits to know

* Signing goes through Circle's API, so submission latency is a network round trip rather than a local signature. Arc's fast finality helps confirmation, but this design does not promise block-level mint sniping.
* Hosted deployments from Arc Studio (Hugging Face) cannot run this worker on the free tier and do not receive Arc Studio's RPC proxy credentials.
