# Multi-chain rollout boundary

The worker now selects RPC chain metadata from Arc Studio's generated onchain-facts registry. `AGENT_CHAIN_ID` defaults to Arc Testnet (5042002); Ethereum (1), Base (8453), and other chains with registered USDC facts can be selected for RPC connectivity and read-only groundwork.

This is **not multi-chain marketplace trading**. A supported RPC chain does not imply a deployed compatible market or safe money conversion. The current indexer projections and marketplace contract are Arc-market-specific, and Circle execution and gas-to-USDC accounting remain Arc Testnet-only. For any chain other than Arc Testnet, strategy execution must remain disabled until a separately reviewed `MarketAdapter`, fee source, native-gas/USD oracle, wallet route, chain-scoped database state, and chain-specific contract deployment are available. Do not copy Arc contract addresses into another chain's configuration.

## Per-chain configuration

- Arc Testnet continues using `VITE_FACTORY_ADDRESS`, `VITE_MARKET_ADDRESS`, `AGENT_START_BLOCK`, `RPC_URL_Arc_Testnet`, and `AGENT_WS_URL`.
- Other chains use `AGENT_FACTORY_ADDRESS_<chainId>` and `AGENT_MARKET_ADDRESS_<chainId>` only after a compatible deployment exists, plus `RPC_URL_<chain-name>` (for example `RPC_URL_Ethereum` or `RPC_URL_Base`) and optional `AGENT_WS_URL_<chainId>`.
- Do not set `testnet-live` for another chain. Circle wallets and execution allowlists are not configured for it.
- Public RPC defaults are for development only; use a private provider for reliable operation.

The chain list is sourced from `src/onchain-facts.ts`; it is not an approval to trade. Chain enablement for live trading requires independent review and tests for each adapter.
