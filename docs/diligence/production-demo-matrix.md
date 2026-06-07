# Production vs demo matrix

An honest, per-component statement of what is production-ready today versus
testnet-only, provider-sandbox-only, wired-but-unexercised, or blocked on an
external dependency. This is the "what is real / what is mocked / what is not
mainnet-ready" table design partners and diligence reviewers ask for.

Status legend:

- **Production-ready**. Live and safe for production use now.
- **Testnet only**. Real implementation, exercised on Base Sepolia; mainnet is
  fenced off (see the escrow / external-audit rows).
- **Sandbox only**. Real client, validated against the provider's sandbox; live
  use needs production provider credentials/approval.
- **Wired, unexercised**. Code path exists and unit/integration-tested, but not
  yet validated end-to-end in the target environment.
- **Dev/test only**. Present for development and demos; **fails closed in
  `NODE_ENV=production`**, so it cannot run against production.
- **Blocked**. Gated on an external dependency that is not yet complete.

## Rails (money movement)

| Component                             | Status        | Notes                                                                                                                                                                                             |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bank_ach` (ACH via Plaid Transfer)   | Sandbox only  | Real `AchPlaidRail` with a real Plaid Transfer client. Registers at boot when Plaid env vars are set. Live use needs production Plaid credentials + Plaid production approval.                    |
| `onchain_base` (native Base transfer) | Testnet only  | Real `OnchainBaseRail` (viem + KMS-signed session key). Base Sepolia; mainnet fenced.                                                                                                             |
| `x402_base` (x402 settlement)         | Testnet only  | Real `X402BaseRail` against the Coinbase facilitator via a real `X402Client`. Base Sepolia.                                                                                                       |
| `escrow_base` (escrow release)        | Testnet only  | Real `EscrowBaseRail` against `BrainEscrow.release`. Base Sepolia; mainnet **double-fenced** (committed audit approval + on-chain bytecode match).                                                |
| `erp_writeback`                       | Dev/test only | Stub. Fails closed in production.                                                                                                                                                                 |
| Stub rails (`rails/stubs.ts`)         | Dev/test only | Retained for dev/test; `defaultRails()` and each dispatch **throw** under `NODE_ENV=production`. A boot fence (`rails-prod-fence`) refuses to start production if zero live rails would register. |

## Contracts (Base)

| Component                  | Status                         | Notes                                                                                                                                                                                                       |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All six protocol contracts | Testnet only                   | Deployed on **Base Sepolia** (addresses in `SECURITY.md`).                                                                                                                                                  |
| Base Sepolia               | Production-ready (testnet)     | Used in dev/staging.                                                                                                                                                                                        |
| Base mainnet               | Blocked                        | Gated on the external smart-contract audit (R-01).                                                                                                                                                          |
| `BrainSmartAccount`        | Testnet only                   | Session-key caps + allowlists; Base Sepolia.                                                                                                                                                                |
| `BrainAuditAnchor`         | Testnet only                   | On-chain audit-root anchoring; Base Sepolia.                                                                                                                                                                |
| `BrainEscrow`              | Testnet only / mainnet Blocked | The only funds-custodying contract. Mainnet registration refused unless `audit-status.json` is `approved` for chain 8453 **and** the deployed runtime bytecode matches the audited build via `eth_getCode`. |
| External contract audit    | Blocked (P0)                   | Not yet engaged (R-01, P0). The P0 blocker for any mainnet custody.                                                                                                                                         |

## Platform controls

| Component                   | Status                                     | Notes                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP auth                    | Production-ready                           | JWT → agent `active` → on-chain `scope_hash` attestation (`BrainMCPAgentRegistry`, 60s cache + RPC fallback) → tool scope → tenant equality. Propose-only (no execute tool).                             |
| RLS tenant isolation        | Production-ready                           | Storage-level RLS on every table; enforced under the non-owner `brain_app` role + `FORCE ROW LEVEL SECURITY` (`infra/db-roles.sql`). `brain_privileged` BYPASSRLS only for sanctioned cross-tenant jobs. |
| §6 pre-execution gate       | Production-ready                           | Deterministic, fail-closed, single choke point; no-bypass enforced by CI guard.                                                                                                                          |
| GDPR Art. 17 erasure        | Production-ready (pending live-cloud test) | Durable, crash-safe, classified-failure, transactional-audit blob erasure. The one remaining item is a production-shaped live-cloud (S3/Azure) integration test (R-02).                                  |
| Audit log + on-chain anchor | Production-ready (testnet anchor)          | Append-only, Merkle-chained; anchor published to Base Sepolia.                                                                                                                                           |

## Environments and tooling

| Component                   | Status             | Notes                                                                                                                                                                     |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo seed / golden-path     | Dev/test only      | Demo provisioning fails closed in production (`demo-provision-fence`). Golden-path runs against the dev stack.                                                            |
| Plaid sandbox               | Sandbox only       | Validated; drives webhooks + simulated transfers.                                                                                                                         |
| Plaid live                  | Sandbox only       | Needs production Plaid credentials/approval.                                                                                                                              |
| Azure deployment            | Wired, unexercised | Deployment workflow exists (`.github/workflows/main.yml`), but the full infra → migrate → boot → readiness → rollback chain has not yet been exercised end-to-end (R-03). |
| CI guards (`pnpm run lint`) | Production-ready   | 14 CI guard scripts enforce gate-no-bypass, loader binding, audit-status integrity, RLS write boundaries, no-on-chain-PII, rails/docs/risk-register drift, and more.      |

## Bottom line

The deterministic safety model (§6 gate, RLS, boot fences, audit trail, MCP
propose-only) is **production-ready**. Money movement is **testnet/sandbox-only**:
on-chain rails run on Base Sepolia, ACH runs against the Plaid sandbox, and
**Base mainnet custody is blocked on the external smart-contract audit**. The
remaining production-hardening items (live-cloud erasure test, exercised Azure
deploy, observability dashboards, load/chaos) are tracked in
`docs/risk-register.md`.
