# Code review map

A guided index to the security- and money-path-critical code in `brain-core`, for
technical investors, design partners, and auditors who want to review the right
paths quickly rather than crawl the tree. Every path below is real and current.

> Orientation: writes flow upward through six layers (Raw → Ledger → Wiki →
> Policy → Agent → Audit). The single rule that matters for diligence: **no money
> moves except through the §6 deterministic pre-execution gate, and that is
> enforced statically (a CI guard) and structurally (one execution choke point).**

## The money path (read these first)

| Concern                        | Path                                                             | What to look for                                                                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §6 pre-execution gate          | `shared/src/gate/`                                               | The deterministic gate every execution must pass: 13 numbered checks + 10 hardening additions (identity, scope, policy, source account, counterparty, sanctions, evidence, balance, approvals, duplicate-payment, audit-before/after). Fail-closed; never reads Wiki; never defers to an LLM. |
| Single execution choke point   | `services/execution/src/payment-intents/PaymentIntentService.ts` | `execute()` is the only path that runs the gate and dispatches a rail. Both `/payment-intents/{id}/execute` and `/actions/{id}/execute` route through it.                                                                                                                                     |
| No-bypass guard (CI)           | `scripts/check-gate-bypass.mjs`                                  | Fails the build if any rail dispatch or transition to `executed` occurs outside `PaymentIntentService`. Wired into `pnpm run lint`.                                                                                                                                                           |
| Money-path loader fence (boot) | `services/api/src/composition/payment-loaders-prod-fence.ts`     | `NODE_ENV=production` refuses to boot unless the always-applicable money-path loaders are wired (evidence/9.5, duplicates/11.5, reservations/8, obligation-direction/6.7, obligation-confidence).                                                                                             |
| Loader-binding guard (CI)      | `scripts/check-payment-intent-loaders.mjs`                       | Static check that loaders are bound at every `PaymentIntentService` mount.                                                                                                                                                                                                                    |
| Money-movement E2E             | `scripts/demo/golden-path.sh`, `tests/e2e/`                      | Full-stack `provision → ingest → normalize → propose → policy → execute → proof` on a real pg+redis stack; runs on every PR. Asserts the gate ran checks 8/9.5/11.5 and that duplicate / policy-reject / missing-approval are rejected.                                                       |

## Agent surface (MCP)

| Concern    | Path                | What to look for                                                                                                                                                                                                                                     |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP server | `services/mcp/src/` | JSON-RPC 2.0 surface at `POST /v1/agents/mcp`. Propose-only: there is **no** `payment_intent.execute` tool. Auth chain: JWT → agent active → on-chain `scope_hash` attestation → tool scope → tenant equality. Every tool call emits an audit event. |

## Policy and contracts

| Concern                       | Path                                   | What to look for                                                                                                                            |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy VM (deterministic)     | `services/policy/src/`                 | Rule evaluation + EIP-712 signing (viem). Writes exactly one `policy_decisions` row per evaluation; never executes or mutates Ledger/Audit. |
| Smart account (session keys)  | `contracts/src/BrainSmartAccount.sol`  | Session-key budget caps (NATIVE/ERC20 modes), allowlisted targets/selectors, policy-version-at-grant, reentrancy + nonce hardening.         |
| Audit anchor                  | `contracts/src/BrainAuditAnchor.sol`   | On-chain Merkle-root anchor for the append-only audit log. A published root cannot be re-published.                                         |
| Escrow                        | `contracts/src/BrainEscrow.sol`        | The only funds-custodying contract. Base Sepolia only until the external audit clears (see fences below).                                   |
| ABI/bytecode drift guard (CI) | `scripts/check-contract-abi-drift.mjs` | Fails on ABI drift between the Solidity artifacts and the committed contract interfaces.                                                    |

## Production boot fences (fail-closed at startup)

| Fence                                  | Path                                                         | Refuses to boot when                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Money-path loaders                     | `services/api/src/composition/payment-loaders-prod-fence.ts` | a required money-path loader is missing in production.                                                                                                                                                 |
| Live rails present                     | `services/api/src/composition/rails-prod-fence.ts`           | production would register zero live rails (so a 100%-fail wave becomes CrashLoopBackoff).                                                                                                              |
| Escrow audit (committed + chain + env) | `services/api/src/composition/escrow-audit-gate.ts`          | Base mainnet + escrow address + the committed `audit-status.json` is not `approved` for this chain, or the deployed bytecode (via `eth_getCode`, immutable-masked) does not match the audited runtime. |
| Demo provisioning                      | `services/api/src/composition/demo-provision-fence.ts`       | demo provisioning would run in production.                                                                                                                                                             |

## Tenant isolation and provenance

| Concern              | Path                                                    | What to look for                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RLS role model       | `infra/db-roles.sql`                                    | Non-owner `brain_app` role + `FORCE ROW LEVEL SECURITY`; `brain_privileged` BYPASSRLS only for sanctioned cross-tenant jobs (normalize, webhook resolver, audit emitter, anchoring). |
| GDPR Art. 17 erasure | `services/api/src/tenant-deletion/blob-purge-worker.ts` | Durable, crash-safe (lease recovery), classified-failure, transactional-audit blob erasure for deleted tenants.                                                                      |
| No on-chain PII (CI) | `scripts/check-no-onchain-pii.mjs`                      | Fails the build if PII could reach an on-chain payload.                                                                                                                              |

## Release / readiness controls

| Concern                         | Path                                               | What to look for                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External-audit gate (CI)        | `scripts/check-audit-status.mjs`                   | Forbids marking `contracts/audit-status.json` `approved` without an auditor, a 40-hex audited commit, a report reference, zero open critical/high findings, build evidence, and `approved_chain_ids`. |
| Production readiness aggregator | `scripts/production-readiness.mjs`                 | Per-rail readiness, per-fence status, CI-guard wiring, and open-risk rows derived from `docs/risk-register.json`. Exit 1 on any red.                                                                  |
| Risk register                   | `docs/risk-register.json`, `docs/risk-register.md` | The machine- and human-readable open-risk register the readiness aggregator reads.                                                                                                                    |
| Production vs demo status       | `docs/diligence/production-demo-matrix.md`         | What is production-ready vs testnet/sandbox/mocked vs blocked-on-audit.                                                                                                                               |

## Test suites

| Suite                                 | Path                 |
| ------------------------------------- | -------------------- |
| Cross-layer invariants (15)           | `tests/invariants/`  |
| Adversarial / security property tests | `tests/adversarial/` |
| Series A E2E proof-points             | `tests/e2e/`         |
| Foundry contract invariants           | `contracts/test/`    |
