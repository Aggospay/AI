# Wallet and credential setup

The agent signs through a Circle developer-controlled wallet on Arc Testnet. The wallet key stays in Circle's custody. This project never sees it.

1. **Circle API key.** Set `CIRCLE_API_KEY` in `.env` (Arc Studio can create one for you).
2. **Entity secret.** A Circle account has exactly one. Put its value in `.env` as `CIRCLE_ENTITY_SECRET`. If this is a new account, `bun run scripts/register-secret.ts` generates and registers one and writes the recovery file under `.circle/`. Back up both the secret and the recovery file. Without them, access to every wallet in the account is lost permanently. If the account already has a secret (error 156015) the script refuses to register another.
3. **Create wallets.** `bun run agent:setup wallets` creates four wallets: `agent`, `treasury` (market owner and fee recipient), `rival-1` and `rival-2` (simulated rivals). Ids are stored in the agent database, addresses are printed.
4. **Fund the agent.** Use Get test USDC in the Arc Studio sidebar for your own wallet, then send USDC to the agent from the dashboard (Fund and status tab). On Arc, USDC is also the gas token: one balance covers trades and fees. Rival wallets need a little USDC too.
5. **Admin token.** The worker creates `AGENT_ADMIN_TOKEN` in `.env` on first start. Paste it into the dashboard. Rotate it by deleting the line and restarting.

## Going live on testnet

Paper mode is the default and needs no wallet. To switch, open Controls, read the warning and type the confirmation phrase. Live mode refuses to turn on unless Circle credentials, the agent wallet and the contract addresses are all present. Mainnet trading is not available in Arc Studio and the code rejects any chain other than Arc Testnet.
