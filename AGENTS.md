# NFT Trading Agent

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

Autonomous NFT trading agent on Arc Testnet: a Bun worker (`agent/`, SQLite state) that indexes our own marketplace contracts, scores collections, mints/buys/lists/undercuts/bids with deterministic rules behind a risk gate, plus a React dashboard (`src/`). Paper mode is the default. Arc Testnet only: code rejects other chains.

### Layout
- `contracts/` ArcCollection, CollectionFactory, NftMarket (+ `contracts/test`, 157 tests)
- `agent/src/` chain/ (indexer, clients), analysis/ (profit, market, scoring), risk/, exec/ (intents, policy allowlist, paper + Circle executors), strategies/, rivals/, server.ts, main.ts
- `agent/test/` 92 Bun tests (`bun run agent:test`)
- `src/components/` dashboard tabs. API client in `src/lib/api.ts`. Vite proxies `/api` to the worker on 8787.
- `docs/` ARCHITECTURE, WALLET_SETUP, DEPLOYMENT

### Rules for future edits
- UI text lives in `src/i18n/en.ts` and the six other locale files (`zh id hi es ar ru`). Add a key to `en.ts` first; the other files then fail typecheck until they have it. Use `t('key')` from `useI18n()`, never a literal string in a component. Keep the `ENABLE TESTNET TRADING` phrase untranslated (the API compares it). Use logical Tailwind classes (`ms-`, `me-`, `text-start`) so Arabic renders right-to-left.
- Money is bigint USDC base units (6 decimals). Gas converts once via `gasCostUsdc`. Never `parseUnits(…, 6)` on a money path.
- Any new onchain call must be added to `agent/src/exec/policy.ts`. Never sign arbitrary calldata or messages.
- Every acquisition passes `checkRisk`. Do not add a path around it.
- Fair value must only use `cleanSales` output (wash filter).
- Keep the min-profitable-price gas budget logic in `strategies/repricer.ts` (planned sell gas is a budget, not an ever-growing cost).

### Mock marketplace safety
- `agent/src/mock-market/` is isolated fixture-only code. It must not import chain, wallet, RPC, signing, or production execution modules.
- Its action methods must remain rejected mock results or `NotImplementedException`; no stateful trades, transactions, approvals, or wallet interaction.
- Keep the production `agent/src/exec/policy.ts` and transaction pipeline unchanged when working on the mock adapter.

### Deployed contracts
Arc Testnet (chain 5042002), deployed 2026-11-15:
- CollectionFactory: `0x37ce029d7281acd725ba9d18deec2de08f122933` (deploy block 72396203)
- NftMarket: `0xf512440a1c1ee2e1f515febdf53f6d337175726f` (fee 250 bps, owner and fee recipient = treasury wallet)
- Wallets (Circle developer-controlled, ids in the agent database): agent `0x21c8...b484`, treasury `0xe086...1b2a`, rival-1 `0x8808...ef9a`, rival-2 `0xbdbd...6dda4`
- Demo collection "Rival Apes": `0x7eac9854c7fc6cc192ddf060c878046e4dcd72bd` (seed preimage in `agent/data/rival-seed.json`, never commit)
- `.env` keys: `VITE_FACTORY_ADDRESS`, `VITE_MARKET_ADDRESS`, `AGENT_START_BLOCK`

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Worker: Bun, bun:sqlite, zod, Circle developer-controlled wallets SDK
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## Share links

- Starter apps already ship `getShareBase`, `buildShareLink` and `installShareSync` in `src/lib/share.ts`; import them instead of rewriting them.
- Keep shareable state in the URL path or query, not in the `#fragment`.
- Never put a secret (private key, claim secret, seed phrase, session token, API key) in the URL path or query, encoded or not.
- Build every link a user copies or sends with `buildShareLink()` from `src/lib/share.ts`.
- Keep the `installShareSync()` call in `src/main.tsx` when editing it; it keeps the Studio address bar in step with in-app navigation.
- Navigate inside the app with relative links.

## To Run

```bash
bun install
bun run dev            # dashboard
bun run agent:start    # worker
bun run agent:mock-market # isolated mock marketplace API on port 8788
bun run check          # lint + typecheck
bun run agent:test
```
