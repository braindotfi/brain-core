# Release notes: v0.1.0-design-partner

> Audience: design partners and technical-diligence reviewers evaluating Brain
> for a pilot. This document states plainly what is production-ready, what is
> staging/sandbox-only, what is mocked, and what is blocked, so a partner can
> decide exactly what to test and what not to rely on yet.

This is a **design-partner** release, not a general-availability release. Money
movement runs on **testnet and provider sandboxes only**. No path in this build
moves real funds on Base mainnet (see "What is blocked" below).

For the per-component status grid see
[`production-demo-matrix.md`](./production-demo-matrix.md). For a guided tour of
the security- and money-path-critical code see
[`code-review-map.md`](./code-review-map.md). Open risks are tracked in
[`../risk-register.md`](../risk-register.md).

## What is production-ready

The deterministic safety model is the core of the product, and it is ready:

- **The §6 pre-execution gate.** Every execution passes one deterministic,
  fail-closed gate (13 numbered checks + 10 hardening additions). It never reads
  Wiki, never defers to an LLM, and cannot be bypassed: a CI guard
  (`check-gate-bypass`) fails the build if any rail dispatch or transition to
  `executed` happens outside `PaymentIntentService`.
- **MCP propose-only surface.** External agents can propose, cancel, and read,
  but there is **no execute tool, ever**. Execution is Brain-internal behind the
  gate. The auth chain is JWT, then agent `active`, then an on-chain `scope_hash`
  attestation (`BrainMCPAgentRegistry`), then tool scope, then tenant equality.
- **Tenant isolation at the storage layer.** Postgres RLS on every table,
  enforced under a non-owner `brain_app` role plus `FORCE ROW LEVEL SECURITY`.
  The `brain_privileged` BYPASSRLS role is used only by sanctioned cross-tenant
  jobs (normalize worker, webhook resolver, audit emitter, anchoring).
- **Append-only, Merkle-chained audit log** with a per-tenant hash chain, an
  exactly-once idempotency key, and a background consistency verifier that
  detects any fork or gap (emits metrics + a critical log).
- **GDPR Art. 17 tenant erasure.** Durable, crash-safe (lease recovery),
  classified-failure, transactional-audit blob purge. The one open item is a
  production-shaped live-cloud integration test (R-02).
- **Production boot fences.** The api refuses to start in `NODE_ENV=production`
  when a required money-path loader is missing, when zero live rails would
  register, when demo provisioning would run, or when mainnet escrow is
  configured without a committed + bytecode-matched external-audit attestation.

## What is staging / sandbox only

- **On-chain rails** (`onchain_base`, `x402_base`, `escrow_base`) run on **Base
  Sepolia**. All six protocol contracts are deployed there (addresses in
  `SECURITY.md`).
- **ACH** (`bank_ach` via Plaid Transfer) runs against the **Plaid sandbox**.
  Live use needs production Plaid credentials and Plaid production approval.
- **On-chain audit anchoring** publishes to Base Sepolia.

## What is mocked or dev/test only

- **Stub rails** (`rails/stubs.ts`) and `erp_writeback` exist for development and
  demos. They **fail closed under `NODE_ENV=production`**: `defaultRails()` and
  each dispatch throw rather than fake-settle.
- **Demo seed / golden-path** provisioning fails closed in production
  (`demo-provision-fence`) and runs against the dev stack only.

## What is blocked (do not rely on these)

- **Base mainnet custody (R-01, P0).** Gated on the external smart-contract
  audit, which is not yet engaged. Mainnet escrow registration is double-fenced:
  a committed `audit-status.json` marked `approved` for chain 8453 **and** a
  deployed-bytecode match via `eth_getCode`.
- **Azure production deploy (R-03, P1).** The deployment workflow exists, but the
  full infra to migrate to boot to readiness to rollback chain has not been
  exercised end-to-end.
- **Live-cloud erasure test (R-02, P0/mitigating).** The erasure logic is ready;
  a production-shaped S3/Azure integration test is outstanding.

## Supported rails

| Rail           | Environment in this release | Live-use prerequisite                           |
| -------------- | --------------------------- | ----------------------------------------------- |
| `bank_ach`     | Plaid sandbox               | Production Plaid credentials + Plaid approval   |
| `onchain_base` | Base Sepolia                | External contract audit (R-01) for mainnet      |
| `x402_base`    | Base Sepolia                | External contract audit (R-01) for mainnet      |
| `escrow_base`  | Base Sepolia                | External audit + on-chain bytecode match (R-01) |

`erp_writeback` and the stub rails are dev/test only and fail closed in
production.

## Contract audit status

Not engaged. All six contracts (`BrainAuditAnchor`, `BrainPolicyRegistry`,
`BrainSmartAccount`, `BrainMCPAgentRegistry`, `BrainEscrow`,
`BrainReputationRegistry`) are deployed and exercised on Base Sepolia; **mainnet
is blocked on the external audit (R-01, P0).**

## Known risks

The authoritative list is [`../risk-register.md`](../risk-register.md). The open
items at this release:

| ID   | Severity | Status     | Summary                                             |
| ---- | -------- | ---------- | --------------------------------------------------- |
| R-01 | P0       | open       | External smart-contract audit not yet complete      |
| R-02 | P0       | mitigating | Live-cloud (S3/Azure) erasure integration test      |
| R-03 | P1       | open       | Azure production deploy chain not yet exercised     |
| R-08 | P2       | mitigating | Rail-adapter money-touching test coverage gap       |
| R-09 | P2       | mitigating | On-chain tumbling vs off-chain rolling spend window |

## Deployment requirements

- Node 22 LTS, pnpm >= 10, Python 3.12 (uv), Docker Compose v2, Foundry,
  Terraform 1.9+.
- Live rails register at boot only when their env vars are configured; with none
  set, the rails boot fence stops a production start rather than failing 100% of
  payments silently.
- Production secrets come only from Azure Key Vault via managed identity.

See [`../v0.4-go-live-runbook.md`](../v0.4-go-live-runbook.md) and
[`../rollback.md`](../rollback.md) for the operational chain.

## Golden-path demo

```bash
pnpm install
pnpm run dev:up            # pg+pgvector, redis, localstack
pnpm run demo:golden-path  # provision, ingest, normalize, propose, policy, execute, proof
pnpm run demo:reset        # wipe + re-seed demo state
```

The golden path runs the full `provision to proof` flow against the local dev
stack and asserts that the §6 gate ran (balance check 8, evidence 9.5,
duplicate-payment 11.5) and that duplicate, policy-reject, and missing-approval
attempts are refused.

## What design partners can safely test

- Proposing payment intents through the MCP surface and via the HTTP API.
- The §6 gate behavior: policy outcomes, approval thresholds, evidence
  requirements, duplicate-payment rejection.
- Autonomy modes (shadow, recommend, confirm, live) and how the policy + agent
  authority + promotion flags combine into one observable mode.
- The audit log and the proof for any executed action
  (`GET /v1/proof/{action_id}`), plus public verification via
  `POST /v1/audit/verify`.
- Source-agnostic ingestion: upload a document, watch it flow to an obligation
  and into earned-autonomy confidence.

## What design partners should not test

- Anything that would move real funds on Base mainnet (blocked).
- Live ACH against real bank accounts (sandbox only in this release).
- A production Azure deployment as a supported, exercised path (R-03).
