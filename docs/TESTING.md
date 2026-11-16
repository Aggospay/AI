# Test results

## Automated
* Contracts: `forge test` passes 157 tests (unit, fuzz, invariants).
* Worker and dashboard logic: `bun run agent:test` passes 103 tests on a simulated chain in paper mode.
* `bun run agent:smoke` (running worker): every API route, authentication, malformed requests, input validation, safe defaults, the live event stream.
* `bun run agent:ui-check` (running worker): renders all 10 dashboard tabs in all 7 languages against live worker data in a simulated DOM and fails on exceptions, `undefined`/`NaN`, missing translations or a wrong text direction. 70 of 70 render cleanly. It cannot judge layout.
* RPC failover: a client given two dead URLs ahead of the real one still reads the chain head.
* `bun run check` (lint and typecheck of the dashboard and worker) is clean.

## Live scenarios on Arc Testnet (2026-11-15)
Run with the agent in testnet-live mode and the simulated rival wallets. Trades with rival wallets happened only with the test-harness switch on (off again afterwards); those trades are synthetic and say nothing about real demand.

| Scenario | Result |
| --- | --- |
| Deploy factory and market, verify owner, registry and fee onchain | Pass |
| Indexer picks up collection creation and events live, catches up after a restart | Pass |
| Operator mint (proposal, approval, USDC allowance, mint through Circle) | Pass |
| Duplicate mint submission is rejected as a duplicate | Pass |
| Agent approves the market and lists the minted token at the minimum profitable price when the rival ask is below it | Pass |
| Lower the profit floor: agent undercuts the rival by one tick (1.600 to 1.599) | Pass |
| Rival undercuts the agent: agent follows one tick below (1.597) | Pass |
| Rival crashes far below the floor: agent stops at the minimum profitable price | Pass, but exposed a bug (below) |
| Agent restart: no duplicate transactions, state and indexer cursor intact | Pass (twice) |
| Agent bids on a collection when sales data exists; rival outbids by one tick; agent counters one tick above | Pass |
| Rival jumps far above the agent's profitable ceiling: agent cancels its offer and recovers the escrow | Pass |
| Agent sells a held token into a rival's standing offer | Pass (realized +0.207 USDC, synthetic counterparty) |
| Agent buys a token listed far below fair value and lists it | Pass |
| Failed transaction (mint with no USDC allowance) is recorded as failed, spend refunded | Pass |

## Bugs found by live testing and fixed
1. Gas treadmill: after a few repricings the floor price rose by each update's own gas, so the agent kept raising its ask to cover the cost of raising it (about 17 updates). It now ignores a shortfall smaller than the cost of another transaction. Covered by new unit tests.
2. Bid drift: with no rival bid, a raised profit ceiling pulled the agent's offer up to the ceiling. It now holds its bid unless a rival matches or beats it.
3. Stale-sale race: right after selling a token into an offer the agent tried to relist it and the transaction failed. It now confirms onchain ownership before relisting.

## Second round (full retest)
| Scenario | Result |
| --- | --- |
| Rival moves up: agent raises its ask from 1.619 to 1.639, one tick below the new lowest competitor | Pass |
| Emergency stop with offers and listings | Failed at first: the pause blocked the cancellations it was meant to send (0 cancelled). Fixed; now cancels the open offer and the listing onchain and stays paused |
| Pause blocks new actions (operator mint rejected as paused) | Pass |
| Malformed request to the pause endpoint | Failed at first: it was read as "resume". Fixed; it now returns 400 |

Further fixes from this round: the dashboard's language module was restructured so editing it no longer crashes the dev preview; the new `relist` rival command and the panic option to delist all listings were added.

## Not verified
* Listing expiry renewal has not been run live (unit tests only).
* The layout of the dashboard in a real browser, including right-to-left Arabic. The render check only proves nothing throws.
* Cross-chain, other marketplaces, predictive and AI features do not exist (see the not-implemented list in the dashboard).
* The Dockerfile and a deployment to an always-on host have not been run.
