# EVM Copy Mint Bot

Phase 1 foundation for a generic EVM-compatible Telegram bot. The project currently initializes validated configuration, PostgreSQL, Redis, Telegraf, structured logging, and dynamic viem clients. Monitoring, decoding, mint detection, wallet custody, signing, and transaction execution are intentionally out of scope.

## Getting started

1. Copy `.env.example` to `.env` and set real values. Never commit `.env`.
2. Start local infrastructure with `docker compose up -d`.
3. Configure the HTTP and WebSocket RPC environment variables listed in `.env.example`. Chain metadata and environment-variable references live in `config/chains.json`; RPC endpoints and credentials do not.
4. Run `npm run dev`.

## Scripts

- `npm run dev`: run with TypeScript watch mode
- `npm run build`: compile to `dist/`
- `npm run start`: run the compiled application
- `npm run typecheck`: strict TypeScript validation
- `npm run lint`: ESLint validation

## Database

Start PostgreSQL locally with `docker compose up -d postgres`. Configure `DATABASE_URL` in `.env`, then run `npm run db:migrate`. Roll back the latest migration with `npm run db:rollback`. Run the database test suite with `npm run test:db` (or all tests with `npm test`).

The migration runner applies the ordered SQL files in `migrations/` transactionally and records applied files in `schema_migrations`. It does not store private keys, seed phrases, or wallet credentials.

## Telegram commands

- `/start` registers the Telegram user and displays the safety notice.
- `/watch` collects a public EVM address and a chain from the configured registry.
- `/status` lists registered monitored addresses and their enabled state.
- `/stop <wallet-id>` disables an address using the ID shown by `/status`.
- `/help` lists the available commands.

## Blockchain monitoring

Run `npm run db:migrate` before starting the application so the monitoring and detection tables exist. The engine creates one block monitor per active configured chain, uses WebSocket block notifications when configured, and falls back to sequential HTTP polling. It records only mined transactions whose sender is an enabled monitored address. Transaction construction and execution are not implemented.

Ethereum, Base, and Robinhood Chain mainnets are configured by default. Each requires a separate HTTP RPC endpoint and WebSocket RPC endpoint through `ETHEREUM_RPC_URL`, `ETHEREUM_WS_RPC_URL`, `BASE_RPC_URL`, `BASE_WS_RPC_URL`, `ROBINHOOD_RPC_URL`, and `ROBINHOOD_WS_RPC_URL`. WebSocket providers must support pending transaction subscriptions for the configured `websocket` pending mode.

## NFT mint detection

Confirmed monitored transactions are analyzed from their transaction receipts. ERC-721 `Transfer`, ERC-1155 `TransferSingle`, and ERC-1155 `TransferBatch` logs are classified as mints only when the token source is the zero address and the recipient is the monitored wallet. Results are stored per emitted token in `detected_mints`; no signing or transaction execution is performed.

## Copy transaction proposals

`MintTransactionAnalyzer` recognizes a deliberately limited registry of public mint calldata shapes and creates unsigned proposals for a supplied destination wallet. Merkle proofs and signature authorizations are never reused and remain eligibility-required. Supported public proposals are simulated and gas-estimated without broadcasting. No nonce, fee settings, private keys, or signatures are stored.

## Phase 7A execution preparation

Ready proposals are linked to the owning database user and expire after ten minutes. Telegram sends an explicit `Execute`/`Skip` notification. Execute performs ownership, registered-wallet, state, and expiry checks, then records an approved execution request; Skip records rejection. The `TransactionExecutor` is intentionally an unconfigured stub and throws if called. This phase never signs or broadcasts a transaction and never asks for private keys or seed phrases.

## Phase 7B pending monitoring

Pending monitoring is a separate fast path from confirmed block reconciliation. Each configured chain has at most one pending stream. `pendingTransactionMode` must explicitly be configured as `websocket`, `filter`, `polling`, or `unsupported`; a WebSocket URL alone does not imply pending support. Pending observations use calldata and sender/nonce state only, with no receipt fetch. Confirmed blocks reconcile pending records as `MINED`; same-sender/same-nonce observations mark older records `REPLACED`, and stale records are marked `DROPPED` after the configured timeout. No signing, spending, or broadcasting is implemented.

## Phase 7C automatic execution

Automatic execution is independent from Telegram and defaults to `DISABLED` for every user. Persistent settings define the destination wallet, allowed chains/contracts, native-value, gas and quantity limits, proposal expiry, and controlled pre-sign retry. Only explicitly recognized public-mint calldata with established destination-wallet eligibility can enter AUTO execution; Merkle proofs, source-wallet signatures, unknown calldata, replaced/dropped sources, and failed simulations are skipped.

The executor atomically claims `(chain, source transaction, destination wallet)`, freshly simulates and estimates gas, verifies the signer address, obtains a destination-wallet pending nonce and current EIP-1559 fees, signs through the isolated `Signer` interface, and only then broadcasts. PostgreSQL advisory locks serialize nonce allocation per destination wallet and chain across application workers. Copy receipts can be reconciled as `CONFIRMED` or `REVERTED` without involving Telegram.

`DevelopmentSigner` accepts `DEVELOPMENT_PRIVATE_KEY` only in development/test and the application rejects that variable in production. It is intentionally unset by default. Production deployments must inject a `ProductionSignerAdapter` backed by an external KMS/HSM or custody service; no production private key, seed phrase, signed transaction, or wallet credential is stored in PostgreSQL or exposed through Telegram. If no signer is configured, AUTO execution remains fail-closed.

Before enabling AUTO with any funded development wallet:

1. Run `npm run db:migrate`.
2. Configure restrictive user execution limits through `ExecutionSettingsService`.
3. Configure only test-chain RPC endpoints and a development-only key.
4. Verify provider pending-transaction coverage and account funding.

Passing local tests does not make a deployment production-ready. Production operation still requires an audited signer/KMS integration, provider redundancy, distributed workers and retry scheduling, balance monitoring, fee escalation/replacement policy, receipt watchers on every enabled chain, alerting, metrics export, and security review.
