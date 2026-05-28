# brain-core System Map

**Audit branch:** `audit/full-system-audit`
**Mapped from:** `main` HEAD `ff6d046` (2026-05-26)
**Prior baseline:** [`_archive/2026-05-25-runtime-reality-audit.md`](./_archive/2026-05-25-runtime-reality-audit.md) (monolithic, rev 6)

This document maps what exists. Not what's intended. Every claim is backed by a file path or command result. Confidence levels explain the quality of each assertion.

---

## 1. Workspace Inventory

All packages declared in `pnpm-workspace.yaml` plus the non-pnpm Python container and Foundry project.

| Workspace | Package | Runtime Role | Entrypoint | Confidence |
|---|---|---|---|---|
| `schemas/` | `@brain/schemas` | Type registry / JSON schema catalog | `schemas/index.ts` (re-exports only) | High |
| `shared/` | `@brain/shared` | Cross-cutting primitives library | `shared/src/index.ts` (barrel) | High |
| `services/api/` | `@brain/api` | **Sole TS runtime process**. HTTP gateway + worker host | `services/api/src/main.ts` (bin: `brain-server`) | High |
| `services/raw/` | `@brain/raw` | Layer 1 ingestion. Fastify plugin composed into api | `services/raw/src/server.ts` (factory); no standalone `main.ts` | High |
| `services/ledger/` | `@brain/ledger` | Layer 2 machine-readable truth. Fastify plugin + normalizeWorker | `services/ledger/src/server.ts`; worker exported as `startNormalizeWorker` | High |
| `services/wiki/` | `@brain/wiki` | Layer 3 narrative/Q&A. Fastify plugin | `services/wiki/src/server.ts` | High |
| `services/policy/` | `@brain/policy` | Layer 4 rule VM + EIP-712 signer. Fastify plugin | `services/policy/src/server.ts` | High |
| `services/execution/` | `@brain/execution` | Layer 5 agent/payment orchestration. Fastify plugin + outbox worker | `services/execution/src/server.ts`; worker as `startOutboxWorker` | High |
| `services/mcp/` | `@brain/mcp` | Layer 5′ MCP JSON-RPC surface. Fastify route plugin | `services/mcp/src/server.ts` (`BrainMcpServer`); mounted via `registerMcpRoute` | High |
| `services/audit/` | `@brain/audit` | Layer 6 Merkle log + webhook dispatcher. Fastify plugin | `services/audit/src/server.ts` | High |
| `services/agent-router/` | `@brain/agent-router` | Cross-cutting. BullMQ routing worker + route plugin; **no standalone process** | `services/agent-router/src/worker.ts` + `src/route.ts`; composed into api via `createAgentRouteWorker` | High |
| `services/internal-agents/` | `@brain/internal-agents` | Cross-cutting. First-party agent catalog library; **no Fastify, no workers** | `services/internal-agents/src/index.ts` (catalog only) | High |
| `clients/sdk/` | `@brain/sdk` | HTTP client SDK (codegen from OpenAPI); not published to npm | `clients/sdk/src/index.ts` | High |
| `tools/migrate/` | `@brain/migrate` | CLI: apply `services/*/migrations/*.sql` | `tools/migrate/dist/cli.js` | High |
| `tools/demo-reset/` | `@brain/demo-reset` | CLI: truncate + re-seed demo tenant |. | Medium |
| `tools/dev-token/` | `@brain/dev-token` | CLI: mint dev JWTs |. | Medium |
| `tools/plaid-sandbox/` | `@brain/plaid-sandbox` | CLI: pull Plaid Sandbox transactions |. | Medium |
| `tools/seed-golden-path/` | `@brain/seed-golden-path` | CLI: seed golden-path demo dataset |. | Medium |
| `tests/e2e/` | `@brain/e2e` | E2E: three "Series A" proof-point tests against staging |. | High |
| `tests/invariants/` | `@brain/invariants` | Static + DB invariants (15 cross-layer + RLS coverage + DB integration) |. | High |
| `tests/adversarial/` | `@brain/adversarial` | Adversarial safety suite. 10 logic + integration CI-only attack-vector tests |. | High |
| `services/agents/` *(not in pnpm)* | Python package | Python container: reconciliation agent + stubs | `services/agents/brain_agents/` | Medium |
| `contracts/` *(not in pnpm)* | Foundry project | 4 Solidity contracts, Base Sepolia deployed | `contracts/src/*.sol` | High |

**Dependency notes (per workspace `package.json`):**

- `@brain/api` depends on: `@brain/agent-router`, `@brain/audit`, `@brain/execution`, `@brain/internal-agents`, `@brain/ledger`, `@brain/mcp`, `@brain/policy`, `@brain/raw`, `@brain/shared`, `@brain/wiki`. Every other TS workspace.
- `@brain/execution` depends on: `@brain/shared`, `@brain/schemas`, `@brain/policy`, `@brain/ledger`.
- `@brain/mcp` depends on: `@brain/shared`, `@brain/execution`, `@brain/ledger`, `@brain/wiki`.
- `@brain/wiki` depends on: `@brain/shared`, `@brain/schemas`.
- `@brain/ledger`, `@brain/policy`, `@brain/raw`, `@brain/audit` depend on: `@brain/shared` only (with minor additions).
- `@brain/agent-router` depends on: `@brain/shared`, `@brain/schemas`, `@brain/internal-agents`.
- `@brain/internal-agents` depends on: `@brain/shared`, `@brain/schemas`.
- `@brain/schemas` has no `@brain/*` dependencies (leaf node).
- `@brain/shared` has no `@brain/*` dependencies (leaf node).

---

## 2. Runtime Entrypoints

**There is exactly one TS runtime process.** The "11 services" presentation is a monorepo development convenience, not a deployment reality.

### Node.js (TypeScript)

| Entrypoint | File | Workers hosted |
|---|---|---|
| `brain-server` binary | `services/api/src/main.ts` | `startNormalizeWorker` (ledger → BullMQ), `startOutboxWorker` (execution rail dispatcher), `createAgentRouteWorker` (BullMQ routing), `anchorBroadcaster` (viem → Base RPC) |

Evidence (`services/api/src/main.ts` grep):
```
line 77:  startNormalizeWorker from "@brain/ledger"
line 101: startOutboxWorker from "@brain/execution"
line 142: registerMcpRoute, BrainMcpServer from "@brain/mcp"
line 151: createAgentRouteWorker, registerAgentApiRoutes from "@brain/agent-router"
line 961: const outboxWorker = startOutboxWorker(...)
line 974: const anchorBroadcaster = createViemAnchorBroadcaster(...)
line 1561: const normalizeWorker = startNormalizeWorker(...)
line 1616: const agentRouteWorker = createAgentRouteWorker(...)
```

All six layer services and both agent infrastructure packages are composed as Fastify plugins into this single process. There is no inter-service HTTP communication within the TS stack.

### Python

| Entrypoint | File | Status |
|---|---|---|
| FastAPI app | `services/agents/brain_agents/` | Prior audit: UNHEALTHY (crash loop). Status as of 2026-05-26: not re-verified. Requires Docker. |

---

## 3. Deploy Units

| Artifact | Source | Status | Notes |
|---|---|---|---|
| Root `Dockerfile` | `/Dockerfile` (multi-stage, Node 22-slim) | **Live deploy target** | Runs `node services/api/dist/main.js`. Single container for all TS services + workers. |
| `services/agents/Dockerfile` | `services/agents/Dockerfile` | Live (in docker-compose) | Python container for `brain_agents`. |
| `services/audit/Dockerfile` | Added P1.5 hardening | **CI build validation only**. Cannot run | `CMD ["node", "services/audit/dist/main.js"]` → no standalone `main.js` exists. TODO noted in file header. |
| `services/execution/Dockerfile` | Added P1.5 | **CI build validation only** | Same pattern. No standalone entrypoint. |
| `services/ledger/Dockerfile` | Added P1.5 | **CI build validation only** | Same pattern. |
| `services/mcp/Dockerfile` | Added P1.5 | **CI build validation only** | Same pattern. |
| `services/policy/Dockerfile` | Added P1.5 | **CI build validation only** | Same pattern. |
| `services/raw/Dockerfile` | Added P1.5 | **CI build validation only** | Same pattern. |
| `services/wiki/Dockerfile` | Added P1.5 | **CI build validation only** | Same pattern. |

**`docker-compose.yml` provisions** (infra-only. Does NOT boot the TS API):
- `postgres`: pgvector/pgvector:pg16, port 5432, volume-persisted, `tools/postgres-init/` mounted as init scripts.
- `redis`: redis:7-alpine, port 6379, appendonly persistence.
- `localstack`: localstack/localstack:3, port 4566, S3 emulation.
- `agents`: Python container (from `services/agents/Dockerfile`).

**`docker-compose.smoke.yml`** (P0.6, new): Full stack including TS API + smoke test runner. Authored without a live stack; must validate end-to-end on first real run (per `BLOCKERS.md` B-1).

**Deployment gap:** The architecture presents 11 discrete services but deploys 1 Node binary + 1 Python container. The per-service Dockerfiles exist for CI build-graph validation and are explicitly documented as prep for a future per-service deployment split. No timeline committed.

---

## 4. Six-Layer Architecture Map

Claimed in `Brain_MVP_Architecture.md` v0.4, `protocol/the-six-layer-stack.md`, and `CLAUDE.md`.

| Layer | # | Workspace | Runtime Evidence | Enforcement |
|---|---|---|---|---|
| Raw | 1 | `services/raw` | Fastify plugin registered in api/main.ts; `/raw/*` routes | `scripts/check-gate-bypass.mjs` guards no bypass |
| Ledger | 2 | `services/ledger` | Fastify plugin; `startNormalizeWorker` consumes BullMQ → writes ledger tables | `scripts/check-wiki-no-ledger-write.mjs` |
| Wiki | 3 | `services/wiki` | Fastify plugin; pgvector + LLM Q&A; reads Ledger tables read-only via `TenantScopedClient` | `scripts/check-policy-no-wiki-read.mjs` |
| Policy | 4 | `services/policy` | Fastify plugin; deterministic VM (`vm.ts`); EIP-712 signer | Same check-policy script |
| Agent/Execution | 5 | `services/execution` | Fastify plugin; PaymentIntent state machine; ApprovalService; sagas; outbox worker | `scripts/check-gate-bypass.mjs` (no bypass) |
| MCP | 5′ | `services/mcp` | Fastify route plugin; 10 tools; JSON-RPC 2.0; mounted via `registerMcpRoute` | No-execute defense (P1.2) |
| Audit | 6 | `services/audit` | Fastify plugin; Merkle chain; webhook dispatcher; on-chain anchor via api/anchorBroadcaster | Append-only enforcement (no UPDATE/DELETE migrations) |

**Cross-cutting (not in the layer table):**
- `services/agent-router`: BullMQ worker; routes domain events/intents to internal agents. No Fastify server of its own; `registerAgentApiRoutes` mounts onto the execution Fastify app.
- `services/internal-agents`: Pure catalog library. Zero HTTP surface. No workers. No migrations. Consumed by agent-router and api.
- `shared/`: Primitives used by every layer. Not a layer itself.

**Layer isolation enforcement quality:**
- `scripts/check-*.mjs` scripts enforce the most critical cross-layer violations (Policy-no-Wiki, Wiki-no-Ledger-write, Gate-bypass) at lint time.
- All scripts are wired into `pnpm run lint` and pre-commit hooks.
- Enforcement is static (AST/text grep), not runtime.
- Layer isolation at the DB level depends on `brain_app` / `brain_privileged` roles from `infra/db-roles.sql` being applied. Not a code-level guarantee.

---

## 5. Dependency Graph (TS Workspaces)

```
@brain/schemas ─────────────────────────────────────────┐
@brain/shared  ─────────────────────────────────────────┤
                                                         │
@brain/raw           ← @brain/shared                    │
@brain/ledger        ← @brain/shared                    │
@brain/wiki          ← @brain/shared, @brain/schemas    │
@brain/policy        ← @brain/shared                    │
@brain/audit         ← @brain/shared                    │
                                                         │
@brain/execution     ← @brain/shared, @brain/schemas,   │
                       @brain/policy, @brain/ledger      │
                                                         │
@brain/mcp           ← @brain/shared, @brain/execution, │
                       @brain/ledger, @brain/wiki        │
                                                         │
@brain/internal-agents ← @brain/shared, @brain/schemas  │
                                                         │
@brain/agent-router  ← @brain/shared, @brain/schemas,   │
                       @brain/internal-agents            │
                                                         │
@brain/api           ← ALL of the above ────────────────┘
```

**Root `tsconfig.json` project-reference gap:**
The root `tsconfig.json` lists project references for: `services/api`, `services/raw`, `services/ledger`, `services/wiki`, `services/policy`, `services/execution`, `services/mcp`, `services/audit`, `clients/sdk`. It does NOT include `services/agent-router` or `services/internal-agents`.

These two workspaces type-check only transitively (via `@brain/agent-router` ← `@brain/api`'s dep). A standalone `pnpm -w tsc -b` will not type-check them unless their parent is reachable. This is a build-graph hygiene issue, not a blocking bug.

**Circular dependency check:** No circular edges observed. The graph is a strict DAG with `@brain/api` as the single composition root and `@brain/schemas`/`@brain/shared` as the leaf nodes.

---

## 6. External Integration Map

| Integration | Consumer(s) | Version / SDK | Status |
|---|---|---|---|
| **Postgres** (pgvector pg16) | All 7 services (own schemas), `tools/migrate` | `pg`, `@pgtyped/runtime` | Required; local via docker-compose |
| **Redis** | api (BullMQ), execution (idempotency), wiki (rate-limit, dev dep) | `ioredis`, `bullmq` | Required; local via docker-compose |
| **BullMQ** | api (3 queue producers), ledger (normalizeWorker), execution (outboxWorker), agent-router (routing worker) | `bullmq` | Required |
| **S3 (LocalStack local / Azure prod)** | api (artifact uploads) | `@aws-sdk/client-s3` + presigner | Local: LocalStack; prod: Azure Blob (Terraform provisioned) |
| **Plaid** | api (`AchPlaidRail`, rail client) | `plaid@^42.2.0` | Real implementation, live SDK integration TBD |
| **Plaid** | raw (webhook ingest, source sync) | `plaid@^27.0.0` | **15-major-version skew**. Likely API surface incompatibilities |
| **Anthropic** | wiki (Q&A), api (agent flows) | `@anthropic-ai/sdk` | Real call paths (credentials required) |
| **OpenAI** | wiki (embedding?), internal-agents | `openai` | Consumed; credentials required |
| **viem / Base RPC** | api (anchorBroadcaster, policy signer, onchain rail) | `viem`, `BASE_RPC_URL` env | Real implementation; live integration TBD |
| **OTLP** | api (OpenTelemetry) | `@opentelemetry/*` | Wired at boot; requires collector endpoint |
| **StatsD** | api | custom metrics module | Wired at boot |
| **Azure Key Vault** | api (KMS-signed session keys for onchain rail) | `@azure/keyvault-keys` | Real implementation; live integration TBD |
| **AES-256-GCM (Plaid creds)** | api, raw | `shared/src/crypto/aes-gcm.ts` | New (2026-05-25); env vars `BRAIN_SOURCE_CREDENTIAL_KEY` + `BRAIN_SOURCE_CREDENTIAL_KEY_ID` |

**Critical skew:** Plaid `^42` (api) vs `^27` (raw). Both packages have their own pnpm lockfile entry. In the single-process deploy they share the same Node runtime but load different Plaid SDK instances. This is structurally safe but means api-side Plaid features (v42 APIs) cannot be reused in raw-side processing without a version bump.

---

## 7. Migration & Database Ownership

Each service owns its schema in a dedicated Postgres schema namespace. The `tools/migrate` CLI discovers all `services/*/migrations/*.sql` files, tracks applied migrations in a `_migrations` table, and runs forward-compatible SQL.

| Service | Migration Dir | File Count | Notable Migrations |
|---|---|---|---|
| `services/api` | `services/api/migrations/` | 2 | `0001_tenants.sql` (RLS on `id = app.tenant_id`), `0002_tenants_default_ap_account.sql` |
| `services/raw` | `services/raw/migrations/` | 7 | Artifacts, parsed, plaid_items, sources (new), force_rls. **Warning: two files share prefix `0004_`** (`0004_force_rls.sql` + `0004_raw_plaid_items_rls.sql`). Migration ordering conflict risk. |
| `services/ledger` | `services/ledger/migrations/` | 20 | Categories → force_rls chain |
| `services/wiki` | `services/wiki/migrations/` | 6 | Entities, relations, pages, role, force_rls |
| `services/policy` | `services/policy/migrations/` | 4 | Policies, decisions, spend_counters (`period_window` rename), force_rls |
| `services/execution` | `services/execution/migrations/` | 20 | Proposals (`0001`) → approvals_hardening (`0020`) |
| `services/audit` | `services/audit/migrations/` | 7 | Audit_events, anchors, webhooks, dead_letters, domain_events, force_rls |
| **Total** |. | **66** | `services/raw` has two files sharing prefix `0004_`. Ordering conflict risk. |

**P0 remediation claims (unverified in this map; require live DB in `database/migrations-and-rls.md`):**
- `period_window` rename: `services/policy/migrations/0003_policy_spend_counters.sql`. Verified in code, not yet in live DB.
- Force-RLS migrations: six new `force_rls` files committed. Code exists, live enforcement requires `infra/db-roles.sql` applied against a running DB.
- New `tests/invariants/integration/db-invariants.integration.test.ts` (CI-only) asserts RLS isolation.

---

## 8. Queue / Event / Scheduler Surfaces

### BullMQ Queues

| Queue name | Producer | Consumer | Status |
|---|---|---|---|
| `brain.ledger.normalize` | `services/raw/` (post-ingest enqueue) | `startNormalizeWorker` (`services/ledger/`) | Active |
| `brain.execution.outbox` | `PaymentIntentService.execute` (enqueues to outbox table, not directly to BullMQ) | `startOutboxWorker` (`services/execution/src/outbox/worker.ts`). Dequeues from DB outbox, dispatches rail | Active |
| `brain.agents.route` | `registerAgentApiRoutes` (`POST /agents/route`) | `createAgentRouteWorker` (`services/agent-router/src/worker.ts`) | Active |

*Exact queue names unverified. Derived from worker registration patterns. Confirm in `queues/bullmq-queues.md`.*

### Domain Event Bus (`shared/src/events/`)

New in 2026-05-25 hardening run. Purpose: emit structured domain events (`agent.mcp.tool_called`, etc.) for observability and downstream consumption. Whether events are consumed by any subscriber beyond logging is unverified. See `queues/domain-events.md`.

### Schedulers / Background Jobs

| Job | Location | Trigger | Notes |
|---|---|---|---|
| Anchor broadcaster | `services/api/src/anchorBroadcaster.ts` (NOT `services/audit/src/`) | Interval / audit event | Writes Merkle root to `BrainAuditAnchor` on Base Sepolia via viem |
| Normalize worker | `services/ledger/src/workers/normalizeWorker.ts` | BullMQ consumer | Raw → Ledger normalization pipeline |
| Outbox worker | `services/execution/src/outbox/worker.ts` | BullMQ consumer | Rail dispatch (ACH Plaid, On-chain Base) |
| Agent route worker | `services/agent-router/src/worker.ts` | BullMQ consumer | Intent → internal agent routing |
| Webhook reconciler | `services/audit/src/reconciler.ts` | Scheduled or triggered | Dead-letter replay |
| Webhook dispatcher | `services/audit/src/webhooks.ts` | Audit event trigger | Fire-and-forget (no retry queue yet. Open debt) |

---

## 9. MCP Surface

**Runtime implementation:** `services/mcp/` (`@brain/mcp`).
**Documentation:** `mcp-server/` (markdown only. Not runtime).

| Attribute | Value |
|---|---|
| Mount | `POST /v1/agents/mcp` via `registerMcpRoute` in api/main.ts |
| Protocol | JSON-RPC 2.0, single-shot HTTP (no SSE, no session state, no streaming) |
| Tools declared | 10 |
| Tool categories | Ledger reads ×5, Wiki reads ×2, `raw.contribute` ×1, propose-only payment/agent actions ×2 |
| Auth chain | Fastify JWT → agent `active` check → `scope_hash` match against on-chain `BrainMCPAgentRegistry` (60s cache, Base RPC) → tool scope → tenant equality |
| No-execute defense | `payment_intent.execute` is NOT a tool. Enforced by P1.2 hardening (snapshot test added) |
| Cross-service DB concern | Prior audit: `services/mcp/src/auth.ts:117` queried execution's `agents` table directly. Must re-verify in `mcp/runtime.md`. |

---

## 10. Smart-Contract Surface

**Runtime contracts:** `contracts/src/` (Foundry project).
**Documentation:** `smart-contracts/` (markdown only. No Solidity source).

| Contract | File | Base Sepolia Address | TS Consumer |
|---|---|---|---|
| `BrainAuditAnchor` | `contracts/src/BrainAuditAnchor.sol` | `0xb900…95ce` (from `.env.example`) | `services/api/src/anchorBroadcaster.ts` via `cfg.AUDIT_ANCHOR_ADDRESS` |
| `BrainPolicyRegistry` | `contracts/src/BrainPolicyRegistry.sol` | `0x6838…2501` | `services/api/src/main.ts` via `cfg.POLICY_REGISTRY_ADDRESS` |
| `BrainMCPAgentRegistry` | `contracts/src/BrainMCPAgentRegistry.sol` | `0xd155…bed7` | `services/mcp/src/auth.ts` (60s cache) |
| `BrainSmartAccount` | `contracts/src/BrainSmartAccount.sol` | Per-tenant factory deploy | `OnchainBaseRail` → `executeViaSessionKey` |

**External audit prep:** `contracts/AUDIT-RFP-DRAFT.md` and `contracts/AUDIT-SCOPE.md` added (P2.1). Foundry fuzz tests for Merkle inclusion added (P1.3, CI-only). Individual Forge test files in `contracts/test/`.

**Verification status:** `forge build` and `forge test` not run in this map pass (no Foundry in environment). See `contracts/foundry.md` for evidence.

---

## 11. Architectural Invariant Lints

Five `scripts/check-*.mjs` files run in `pnpm run lint` and pre-commit hook:

| Script | Enforces | Mechanism |
|---|---|---|
| `check-gate-bypass.mjs` | §6 gate: no money-movement (`rail dispatch`, `executed` transition) outside `PaymentIntentService` | AST/text scan of TS source |
| `check-policy-no-wiki-read.mjs` | Policy layer must never import from Wiki layer | Import path analysis |
| `check-wiki-no-ledger-write.mjs` | Wiki layer must never write to Ledger | Import + mutation pattern scan |
| `check-promotion-readiness.mjs` | H-24: agent promotion from SHADOW to LIVE requires explicit gate | Import/flag analysis |
| `check-scope-vocab.mjs` | Scope string literals must match the canonical scope vocabulary | String literal scan |

All five are wired into `pnpm run lint`. Static enforcement only. Violations cause lint failure, not runtime errors.

Additionally, `tests/invariants/` (`@brain/invariants`) enforces 15 cross-layer properties at test time including RLS coverage scan, tenant isolation, and schema invariants. `tests/adversarial/` adds 10 attack-vector unit tests (10 CI-only integration tests also present but require live DB).

---

## 12. Confidence-Tagged Unknowns

The following areas require deeper investigation in per-subsystem audit turns.

| Area | Confidence | Why Low / What's Uncertain |
|---|---|---|
| P0 remediations live in DB | **Low** | Code changes committed; RLS and `period_window` must be verified against a running Postgres instance. `BLOCKERS.md` B-1 confirms no live infra available in the audit environment. CI is the only verifier. |
| Python agents (`services/agents/`) health | **Low** | Prior audit: UNHEALTHY crash loop. No Docker available to re-check. Still unverified as of this map. |
| `anchorBroadcaster` live activation | **Low** | Requires `AUDIT_ANCHOR_ADDRESS` + `BASE_RPC_URL` + funded wallet. Cannot verify without secrets. |
| MCP cross-service DB access (`auth.ts:117`) | **Medium** | Flagged in prior audit. Hardening commits touched services/mcp but unclear if this violation was resolved. Requires code trace in `mcp/runtime.md`. |
| Per-service Dockerfiles runnable | **Low** | Their `CMD` targets `dist/main.js` which requires a standalone entrypoint not yet written. Intentionally deferred. |
| BullMQ queue names (exact) | **Medium** | Derived from worker registration patterns; exact names require reading worker source. Audit in `queues/bullmq-queues.md`. |
| Domain event bus consumers | **Low** | `shared/src/events/` exists; whether events have real subscribers beyond in-process logging is unverified. |
| Plaid v42/v27 API surface impact | **Low** | The skew is confirmed; whether it causes actual incompatibility requires checking which v27-only API methods `services/raw` uses. |
| On-chain rail live wiring | **Low** | `OnchainBaseRail` and `AchPlaidRail` have real implementations (CLAUDE.md); live SDK construction and integration verification are explicitly deferred (per CLAUDE.md "Known in-progress work"). |
| Webhook retry queue | **Low** | `WebhookAuditEmitter` is explicitly fire-and-forget; BullMQ retry worker is "planned follow-up" per CLAUDE.md. Currently unimplemented. |
| Root tsconfig project-ref gap impact | **Medium** | `agent-router` and `internal-agents` not in root `tsconfig.json`. Type errors in these packages may be masked in CI if they're only ever built transitively. |

---

*Evidence basis: `git log --since=2026-05-24` (74 files, +4408/−117), Explore agent reads of per-workspace `package.json` and entrypoints, grep of `services/api/src/main.ts`, `BLOCKERS.md`, `HARDENING-SUMMARY.md`, `CLAUDE.md`, `docker-compose.yml`, `pnpm-workspace.yaml`.*
