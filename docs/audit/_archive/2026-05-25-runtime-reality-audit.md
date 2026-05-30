> **Archived.** This is the monolithic rev-6 audit from 2026-05-25. It is superseded by the modular audit indexed at [`../index.md`](../index.md). Retained for diffing and historical reference. Known errors: `anchorBroadcaster` path cited as `services/audit/src/` is incorrect. Actual location is `services/api/src/anchorBroadcaster.ts`.

# brain-core Runtime Reality Audit

**Date:** 2026-05-25  
**Audited ref:** main (HEAD, ~2026-05-25)  
**Prior audit baseline:** `docs/audits/current-branch-audit.md` (2026-05-19, rev 5, `feat/poc-investor-demo`, commit `a6ed66e`)  
**Method:** Static execution-path tracing + live smoke test (Postgres at :5432, Redis at :6379, LocalStack at :4566 via Docker Compose). Implementation is the only source of truth; documentation is a claim to be verified.

---

## 1. Executive Summary

**Architecture coherence score: 5/10**

The codebase is significantly more mature than a typical prototype. Core financial primitives (pre-execution gate, policy VM, Merkle audit chain, MCP server) are real, well-tested implementations. The six-layer boundary is largely clean. The codebase has correct mental models.

**But it cannot deploy as-is.** Three production-blocking failures exist independently of each other:

1. **The boot binary does not compile.** `services/api/src/main.ts` is explicitly excluded from the TypeScript build (`tsconfig.json:exclude`). `services/api/dist/main.js` does not exist. The Docker `ENTRYPOINT ["node", "services/api/dist/main.js"]` fails with `MODULE_NOT_FOUND` at container start.

2. **A migration is broken.** `policy/0003_policy_spend_counters.sql` uses `window` as a column name. A PostgreSQL reserved keyword. Producing `syntax error at or near "window"`. The agent rate-limiting feature (spend windows, tx caps) is undeployable. Any migration run halts here; migrations after this point in the policy service are also unapplied.

3. **Tenant isolation (RLS) is not enforced.** `FORCE ROW LEVEL SECURITY` has not been applied to any table (`relforcerowsecurity = f` on all 43 tables). All services connect as the table owner `brain`, which Postgres exempts from RLS by default. The isolation model is architecturally correct but runtime-inactive. `infra/db-roles.sql` exists but has never been applied.

Beyond these blockers:

- Three of the gate's most important checks (evidence semantic validation, duplicate-payment detection, double-spend reservation accounting) are **not wired** in the call to `runPreExecutionGate`; they silently pass as "not applicable" on every execution.
- All payment rails are **stubs** that throw in `NODE_ENV=production`. No real money has ever moved through this system.
- "Agents" are **routing functions** (16–39 LOC), not autonomous agents. No planning loop, no memory, no retry/recovery, no LLM invocation in any TS internal agent handler.
- The Python agent layer advertised as "three MVP agents" contains **one** working agent (reconciliation). The container is in a crash loop in the live environment.

**Strongest systems:** Pre-execution gate, Policy VM, Merkle audit chain, MCP protocol implementation, architectural lint guards, PaymentIntent state machine, saga executor, idempotency layer.

**Weakest systems:** Boot binary build, payment rails, RLS enforcement, agent autonomy claims, Python agent layer, missing JSON Schemas, spend-window migration.

**Production readiness:** NOT READY. Three independent blockers prevent a deployable artifact.

---

## 2. Real Runtime Architecture

### 2.1 Process Model

**One Node.js process per deployment.** `services/api/src/main.ts` is the single boot binary (`brain-server`). It composes all six TS layers as Fastify plugins into one process on port 3000. There is no service mesh, no inter-service HTTP, no microservice split. Everything is in-process via direct function calls.

**One Python process.** `services/agents/` runs FastAPI on port 8001 (separate Docker service, unhealthy in the live environment). It is completely decoupled from the TS monolith; the TS monolith does not call it. The Python layer proposes actions back via `POST /v1/execution/propose` (which is a legacy route).

**Infrastructure dependencies:** Postgres :5432 (pgvector/pg16), Redis :6379 (native on host, not in Docker Compose in the live environment), LocalStack :4566 (S3 emulation).

### 2.2 Boot Sequence (as designed. Boot binary currently cannot compile)

```
Node start → instrumentation.ts (OTLP tracing) → Fastify root
  → fastifyCors, fastifyHelmet, fastifyRateLimit (300/min)
  → requestIdPlugin, errorHandlerPlugin, authPlugin (JwtVerifier)
  → idempotencyPlugin (Redis 24h TTL)
  → mount under /v1:
      registerRawPlugin        → /raw/*
      registerLedgerPlugin     → /ledger/*
      registerWikiPlugin       → /wiki/*
      registerPolicyRoutes     → /policy/*
      registerExecutionRoutes  → /execution/* (v0.2 legacy)
      registerPaymentIntentRoutes → /payment-intents/* (v0.3)
      registerAuditRoutes      → /audit/*
      registerWebhookRoutes    → /webhooks/*
      registerProofRoutes      → /proof/*
      registerMcpRoute         → /agents/mcp (optional, guarded by on-chain auth)
      registerAgentApiRoutes   → /agents/*
      registerSiwxRoutes       → /auth/siwx/*
      [demo] /demo/token, /demo/policy/activate, /demo/anchor/trigger
  → background: startNormalizeWorker (Ledger normalization)
  → background: anchor publisher (hourly timer, or 10s in demo mode)
  → background: agent route worker (Redis event consumer)
  → listen :3000
```

**Actual dev path:** `tsx watch src/main.ts` (not the compiled binary). Production path: broken.

### 2.3 Data Flow

```
External HTTP → api (port 3000, JWT auth)
  → (reads) → ledger service plugins (own DB schema)
  → (reads) → wiki service (reads ledger tables READ-ONLY via TenantScopedClient)
  → (reads) → policy service (reads policy tables)
  → (execute) → PaymentIntentService.execute()
      → runPreExecutionGate (shared/src/gate/gate.ts)
          → evaluatePolicy → policy VM (deterministic, no LLM)
          → resolveAgent, resolveAccount, resolveCounterparty
          → [resolveEvidence → NOT WIRED, check 9.5 = not-applicable]
          → [detectDuplicates → NOT WIRED, check 11.5 = not-applicable]
          → [sumActiveReservations → NOT WIRED, uses "0"]
          → audit.emit(payment_intent.execute.before)
      → withTenantScope: transition approved→dispatching + insert outbox row (atomic)
      → return 202 {outbox_id}
  → outbox worker (background, Redis) → claims outbox row
      → rail.dispatch() → stub (throws in production)
      → PaymentIntentService.completeExecution() → transition dispatching→executed
      → audit.emit(payment_intent.execute.after)

MCP path → POST /agents/mcp
  → JWT auth → McpAuthVerifier.verify()
      → SELECT agents WHERE id = $1  ← direct DB read of execution's table
      → on-chain BrainMCPAgentRegistry scope hash check (60s cache)
      → [FakeAuthVerifier if BRAIN_MCP_DEV_AUTH_BYPASS=true AND NODE_ENV != production]
  → BrainMcpServer.handle() → dispatch JSON-RPC
      → tools: ledger.account.get, ledger.accounts.list, ledger.transactions.list,
               ledger.obligations.list, ledger.counterparties.list,
               wiki.question, wiki.page.get,
               raw.contribute,
               payment_intent.propose,
               agent.action.propose [agentService OPTIONAL → 500 if absent]
```

---

## 3. Claimed vs Actual Architecture

| Claim                                      | Source                               | Reality                                                                      | Status     |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------- | ---------- |
| Six-layer architecture                     | CLAUDE.md, Brain_MVP_Architecture.md | Layers exist, boundaries respected by code                                   | REAL       |
| Monolithic boot binary                     | docs/boot-binary-spec.md             | Designed correctly but main.ts excluded from build                           | PARTIAL    |
| 16 gate checks                             | CLAUDE.md                            | 17 check positions (13 base + 4 .5 variants); 3 critical checks unwired      | PARTIAL    |
| Policy VM + EIP-712 signing                | CLAUDE.md                            | VM real; EIP-712 signing in services/policy/src/signing.ts                   | REAL       |
| Merkle-chained audit log + on-chain anchor | CLAUDE.md                            | Merkle real (keccak256, matches contract); anchor broadcaster real           | REAL       |
| 10 MCP tools                               | CLAUDE.md                            | Exactly 10 (5 ledger + 2 wiki + 1 raw + 1 PI + 1 agent)                      | REAL       |
| On-chain scope hash verification           | CLAUDE.md                            | McpAuthVerifier.verify() calls getOnchainScopeHash() (60s cache)             | REAL       |
| ACH + on-chain payment rails               | CLAUDE.md                            | Code exists (ach-plaid.ts, onchain-base.ts) but stubs used in defaultRails() | PARTIAL    |
| Three Python MVP agents                    | CLAUDE.md                            | 1 implemented (reconciliation); payment + anomaly = future work              | PARTIAL    |
| Tenant isolation via RLS                   | All docs                             | RLS armed but NOT enforced (FORCE RLS not applied)                           | PARTIAL    |
| Agent autonomy (autonomous agents)         | docs/agent-autonomy-v3.md            | 19 handlers, 16–39 LOC each, pure routing functions                          | MISLEADING |
| Spend window rate-limiting                 | CLAUDE.md, policy VM                 | Migration broken (reserved keyword `window`), table missing                  | BROKEN     |
| E2E tests (3 Series A proof-points)        | CLAUDE.md                            | 3 .e2e.test.ts files exist but require live staging                          | PARTIAL    |
| 15 cross-layer invariants                  | CLAUDE.md                            | 5 invariant test files, covers ~15 invariants (DB-level tests separate)      | REAL       |
| JSON Schemas for 11 Ledger entities        | CLAUDE.md                            | 6 schemas (account, agent, counterparty, obligation, policy, transaction)    | PARTIAL    |
| Outbound webhook retries                   | CLAUDE.md                            | "fire-and-forget, no retry queue". Explicitly marked as follow-up            | DEAD       |
| @brain/sdk published to npm                | CLAUDE.md                            | Exists but "not yet published"                                               | PARTIAL    |

---

## 4. Six-Layer Architecture Audit

### Layer 1. Raw (`services/raw`, `@brain/raw`)

- **Intended:** Source evidence ingestion, immutable payloads
- **Reality:** Real. `registerRawPlugin` mounts under `/raw/*`. Plaid webhook handling, artifact storage (Azure Blob / LocalStack), raw_artifacts/raw_parsed/raw_plaid_items tables all exist.
- **Violations:** None found
- **Status:** MOSTLY COMPLETE. Plaid extraction code exists; live Plaid sandbox wiring is pending

### Layer 2. Ledger (`services/ledger`, `@brain/ledger`)

- **Intended:** Machine-readable financial truth, 11 typed entities
- **Reality:** Real and comprehensive. 10 ledger entity tables with RLS-armed migrations. `LedgerPaymentIntents` facade properly used by execution layer.
- **Entity count discrepancy:** Docs say "11 entities" but 12 ledger tables exist (categories, counterparties, accounts, balances, documents, transactions, obligations, invoices, transfers, payment_intents, reconciliation_matches, reservations). Docs likely don't count `reservations` as an entity.
- **JSON Schema gap:** Only 6 of 12 entity types have JSON Schema files in `schemas/entity/`. Missing schemas for balance, document, invoice, transfer, reconciliation_match, reservation, payment_intent.
- **Violations:** None in the layer boundary. Execution uses `@brain/ledger` facade (not direct SQL).
- **Status:** REAL. Schema mature; JSON Schema coverage incomplete

### Layer 3. Wiki (`services/wiki`, `@brain/wiki`)

- **Intended:** Human-readable memory + narrative Q&A, pgvector
- **Reality:** Real. wiki_entities, wiki_pages, wiki_relations tables exist. pgvector integration present. Reads Ledger tables READ-ONLY via `TenantScopedClient` (sanctioned exception).
- **Violations:** The `check-wiki-no-ledger-write.mjs` guard confirms no write violations. A comment in `wiki/src/index.ts:7` references a stale migration note. Cosmetic only.
- **Status:** REAL

### Layer 4. Policy (`services/policy`, `@brain/policy`)

- **Intended:** Deterministic rule VM, EIP-712 signing
- **Reality:** Real. `vm.ts` is a pure function over 6 primitives with no external I/O. `signing.ts` uses viem for EIP-712. Policy DSL compiled and tested. `check-policy-no-wiki-read.mjs` confirms no wiki reads.
- **Spend counter BROKEN:** `policy_spend_counters` table missing due to migration failure. The VM accepts `spend_in_window` / `tx_count_in_window` from the caller. But the caller cannot populate them without this table. Agent rate-limiting (1b.2) is non-functional.
- **Status:** MOSTLY COMPLETE. VM real; spend counter feature broken

### Layer 5. Execution (`services/execution`, `@brain/execution`)

- **Intended:** PaymentIntent lifecycle, approval, orchestration
- **Reality:** Mostly real. `PaymentIntentService` is complete (create, approve, reject, cancel, pause, resume, pauseByAgent, execute, completeExecution, failExecution, replayInvestigation). State machine enforced. Outbox worker real (269 LOC). Saga executor real. `check-gate-bypass.mjs` confirms only worker.ts dispatches rails.
- **Critical gap:** `gateDeps()` in PaymentIntentService omits `resolveEvidence`, `detectDuplicates`, `sumActiveReservations`. Gate checks 9.5, 11.5, and the reservation sub-check of 8 are always "not-applicable".
- **Cross-service DB violation:** Execution owns `agents` table (migration 0003_agents.sql), but `services/mcp/src/auth.ts:117` directly queries it via raw SQL.
- **Status:** MOSTLY COMPLETE. Execution chain real; three gate sub-checks unwired; one cross-service violation

### Layer 5′. MCP (`services/mcp`, `@brain/mcp`)

- **Intended:** JSON-RPC 2.0 server, external agent surface
- **Reality:** Real. 10 tools, 5 resources, 5 prompts, single-shot HTTP transport, proper scope enforcement, audit emission.
- **`agentService` optional:** `McpServerDeps.agentService` is optional. If absent at boot, `agent.action.propose` returns 500. Risk: boot wiring may skip this.
- **Status:** REAL (with caveats. See §6)

### Layer 6. Audit (`services/audit`, `@brain/audit`)

- **Intended:** Append-only Merkle-chained log + on-chain anchor
- **Reality:** Real. Merkle tree uses keccak256 matching the Solidity contract exactly. `publishAnchor` function is complete. Anchor broadcaster wired to Base Sepolia via viem. Reconciler exists for verifying on-chain anchors.
- **Status:** REAL

### Boundary violations

- **Policy ← Wiki:** CLEAN (lint guard + grep confirm zero violations)
- **Execution ← Wiki:** CLEAN
- **Wiki → Ledger writes:** CLEAN (lint guard confirms)
- **MCP → Execution DB (agents table):** VIOLATION. `McpAuthVerifier` queries execution's `agents` table directly (auth.ts:117–124), bypassing the "cross-service reads through owning API" rule
- **Wiki ← Ledger (direct reads):** SANCTIONED. Uses `TenantScopedClient` for read-only access as documented

---

## 5. Agent System Audit

### TypeScript Internal Agents (19 registered)

All 19 handlers are classified as **WORKFLOW_ROUTER** (not autonomous agents).

**Pattern distribution:**

- 12 handlers (collections, reconciliation, subscription, dispute, compliance, revenue_intel, personal_budget, fraud_anomaly, tax_prep, travel_finance, financial_health, purchase_advisor): pure delegation. `return agentProposal(input)`. 16–21 LOC
- 5 handlers (treasury, payment, bill_management, savings, debt_optimization): conditional routing. `if FINANCIAL_ACTION → payment_intent channel, else → agent channel`. 30–39 LOC
- 2 handlers (vendor_risk, cash_forecast): evidence/type-gated. `if hasRiskEvidence / if REPORT_ACTIONS → structured output`. 34 LOC

**What these agents do NOT have:**

- No LLM calls (no `@brain/shared` LLM adapter usage in any handler)
- No planning loop or step decomposition
- No memory read or write
- No retry or recovery logic
- No state persistence per agent run
- No timeout/cancellation
- No evaluation or scoring
- No dynamic tool selection

**What these agents DO:**

- Receive an `AgentInput` (action type + context)
- Route to one of two channels: `payment_intent.create` or `agent.propose`
- Return a `ProposedAction` in a single synchronous function call

The `AgentRun` table (`execution/migrations/0008_agent_runs.sql`) exists with columns for reasoning_trace, evidence_refs, sagas. So the **infrastructure** for autonomous behavior exists in the schema, but is not populated by any current handler.

**The agent router:**

- `services/agent-router/src/` → routes domain events/intents to internal agent handlers
- Real infrastructure. `AgentRunService` persists run records. `AgentRouter` dispatches via Redis queue.
- The promotion policy, intent classifier, embedding classifier, and intent decomposer all exist as modules.

**Summary:** The agent INFRASTRUCTURE is real (routing, persistence, scheduling). The agent BEHAVIOR is minimal routing functions. 16–39 LOC per handler. Docs claiming "autonomous agents" are architecturally aspirational.

### Python Agents (`services/agents/`)

| Agent                   | Claimed | Reality                                                                                     | Status                           |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| Reconciliation          | ✓       | ReconciliationAgent (41 LOC) calls OpenAI GPT-4o-mini, routes to brain API propose endpoint | REAL (but unhealthy in live env) |
| Payment agent           | ✓       | Not implemented (`__init__.py:5`: "later stages")                                           | DEAD                             |
| Anomaly/Plaid extractor | ✓       | Not implemented                                                                             | DEAD                             |

**Live environment:** `brain-agents` container is UNHEALTHY. The FastAPI service starts and immediately crashes (likely missing `OPENAI_API_KEY` or `brain_api_token`). The crash is a lifespan failure. The container restart loop is visible in Docker logs.

**Python config gotcha:** `brain_api_base_url` defaults to `localhost:3001` (not 3000). If the TS API runs on 3000, the Python agent points to a dead port.

---

## 6. MCP Audit

### Implementation Status

| Component                           | Claimed      | Reality                                                                                                                                                                                                                         |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 tools                            | ✓            | Exactly 10: ledger.account.get, ledger.accounts.list, ledger.transactions.list, ledger.obligations.list, ledger.counterparties.list, wiki.question, wiki.page.get, raw.contribute, payment_intent.propose, agent.action.propose |
| 5 resource URIs                     | ✓            | `resources.ts` exists. Not read in this audit; claimed by server                                                                                                                                                                |
| 5 prompts                           | ✓            | `prompts.ts` exists                                                                                                                                                                                                             |
| Single-shot HTTP, no SSE            | ✓            | `transport/http.ts:32`: one POST → one response, no streaming                                                                                                                                                                   |
| On-chain scope hash check           | ✓            | `auth.ts:94–103`: `McpAuthVerifier.onchainScopeHashCached()` calls `OnchainScopeChecker.getOnchainScopeHash()`                                                                                                                  |
| 60s cache                           | ✓            | `auth.ts:52`: `CACHE_TTL_MS = 60_000`                                                                                                                                                                                           |
| RPC fallback                        | Not verified | Interface `OnchainScopeChecker` injected. Concrete impl depends on boot wiring                                                                                                                                                  |
| No `payment_intent.execute` tool    | ✓            | Confirmed absent from registry                                                                                                                                                                                                  |
| `agent.mcp.tool_called` audit event | ✓            | `server.ts:182–189`: emits on every tool call                                                                                                                                                                                   |
| `agentService` optional             | UNDOCUMENTED | `McpServerDeps.agentService?`. If absent, `agent.action.propose` returns 500                                                                                                                                                    |

### Auth Chain Vulnerability

`McpAuthVerifier.loadAgent()` (`auth.ts:115–124`) runs:

```sql
SELECT id, tenant_id, state, scope_hash, onchain_address, role
FROM agents WHERE id = $1 LIMIT 1
```

directly against the `agents` table. Which belongs to `services/execution` (migration 0003_agents.sql). This is a direct cross-service DB read, violating the architectural principle. The execution service's agent management API is bypassed.

### Dev Bypass

`BRAIN_MCP_DEV_AUTH_BYPASS=true` replaces `McpAuthVerifier` with `FakeAuthVerifier` (skips all agent record checks and on-chain verification). Guarded to fail if `NODE_ENV=production` (`main.ts:465–466`). Safe as documented; risk is only in non-production environments where bypass may be silently enabled.

---

## 7. Subsystem Reality Matrix

| Subsystem                   | Claimed Purpose                | Runtime Reality                                                                           | Status          | Severity | Evidence                                                                    |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- | --------------- | -------- | --------------------------------------------------------------------------- |
| Boot binary                 | Single-process deployable      | `main.ts` excluded from tsconfig; `dist/main.js` never produced                           | BROKEN          | CRITICAL | `services/api/tsconfig.json:exclude`, `dist/` listing                       |
| Pre-execution gate          | 16 deterministic checks        | 13 base + 4 .5-variant checks; 3 not wired (9.5, 11.5, 8-reservation)                     | PARTIAL         | HIGH     | `shared/src/gate/gate.ts`, `PaymentIntentService.gateDeps()`                |
| Policy VM                   | Deterministic rule evaluation  | Real 6-primitive VM; property-tested                                                      | COMPLETE        | .        | `services/policy/src/vm.ts:50`                                              |
| EIP-712 signing             | Policy proof signing           | Real viem implementation                                                                  | COMPLETE        | .        | `services/policy/src/signing.ts`                                            |
| Spend window counters       | Agent rate limiting (1b.2)     | `policy_spend_counters` table missing: migration syntax error (`window` reserved keyword) | BROKEN          | HIGH     | `services/policy/migrations/0003_policy_spend_counters.sql`                 |
| Merkle audit chain          | Append-only tamper-evident log | Real keccak256, matches Solidity contract                                                 | COMPLETE        | .        | `services/audit/src/merkle.ts`                                              |
| On-chain anchor             | Merkle root → Base Sepolia     | Real viem write to BrainAuditAnchor; hourly timer wired                                   | COMPLETE        | .        | `services/api/src/anchorBroadcaster.ts`, `services/audit/src/publisher.ts`  |
| Tenant isolation (RLS)      | Row-level tenant separation    | Migrations arm RLS; FORCE ROW LEVEL SECURITY never applied                                | PARTIAL         | CRITICAL | `psql: relforcerowsecurity = f` on all 43 tables; `infra/db-roles.sql` note |
| Bank ACH rail               | Real ACH money movement        | `AchPlaidRail` code exists; `defaultRails()` uses `BankAchStubRail` (throws in prod)      | PARTIAL         | HIGH     | `services/execution/src/rails/stubs.ts:99–104`                              |
| On-chain rail               | Base Sepolia transfers         | `OnchainBaseRail` code exists; `defaultRails()` uses stub                                 | PARTIAL         | HIGH     | Same                                                                        |
| Outbox worker               | Durable async rail dispatch    | Real implementation; integration tests blocked in sandbox                                 | MOSTLY COMPLETE | MEDIUM   | `services/execution/src/outbox/worker.ts:269 lines`                         |
| Internal agents (19)        | Autonomous financial agents    | 16–39 LOC routing functions; no LLM, no memory, no planning                               | MISLEADING      | HIGH     | `services/internal-agents/src/` agent handlers                              |
| Python reconciliation       | LLM-based reconciliation       | Real OpenAI call; container UNHEALTHY in live env                                         | PARTIAL         | HIGH     | `services/agents/brain_agents/reconciliation/agent.py`                      |
| Python payment agent        | Autonomous payment agent       | Not implemented                                                                           | DEAD            | HIGH     | `brain_agents/__init__.py:5`                                                |
| Python anomaly agent        | Plaid extraction/anomaly       | Not implemented                                                                           | DEAD            | MEDIUM   | Same                                                                        |
| MCP server                  | 10-tool JSON-RPC surface       | Real 10 tools, proper auth, audit                                                         | COMPLETE        | .        | `services/mcp/src/`                                                         |
| MCP on-chain auth           | BrainMCPAgentRegistry check    | Real; 60s cache; dev bypass properly guarded                                              | COMPLETE        | .        | `services/mcp/src/auth.ts`                                                  |
| MCP cross-service DB        | (should not exist)             | `McpAuthVerifier` directly queries execution's `agents` table                             | VIOLATION       | MEDIUM   | `auth.ts:117`                                                               |
| PaymentIntent state machine | Legal state transitions        | Real; all transitions validated via `assertPaymentIntentTransition`                       | COMPLETE        | .        | `services/execution/src/payment-intents/state-machine.ts`                   |
| Saga executor               | Multi-step compensation        | Real; audit events per compensation step                                                  | COMPLETE        | .        | `services/execution/src/sagas.ts`                                           |
| Idempotency                 | 24h Redis dedup                | Real; `shared/src/idempotency/` + Redis store                                             | COMPLETE        | .        | `main.ts` plugin registration                                               |
| Wiki pgvector               | Semantic search                | Tables and schema exist; retrieval implementation in wiki service                         | MOSTLY COMPLETE | .        | `wiki_pages` table + wiki service                                           |
| LLM abstraction             | Provider-neutral LLM client    | Real adapters: OpenAI, Anthropic, RecordedAdapter                                         | COMPLETE        | .        | `shared/src/llm/`                                                           |
| E2E tests                   | 3 Series A proof-points        | 3 `.e2e.test.ts` files exist; require staging env                                         | PARTIAL         | MEDIUM   | `tests/e2e/`                                                                |
| Invariants tests            | 15 cross-layer invariants      | 5 test files, 15 invariants covered (DB-level separately)                                 | REAL            | .        | `tests/invariants/src/`                                                     |
| JSON Schemas                | 11 entity schemas              | 6 schemas; 5–6 entity types unschematized                                                 | PARTIAL         | MEDIUM   | `schemas/entity/` (6 files)                                                 |
| Smart contracts             | 4 Solidity contracts           | Build artifacts in `contracts/`; not verified in this audit                               | NOT VERIFIED    | .        |                                                                             |
| @brain/sdk                  | Published typed client         | Generated from OpenAPI; not published to npm                                              | PARTIAL         | LOW      | `clients/sdk`                                                               |

---

## 8. Dead / Fake Architecture

### 8.1 Fake-Complete Systems

1. **Agent autonomy**. 19 handlers described as "autonomous agents" are routing decision trees, 16–39 LOC. No planning, no memory, no loops, no LLM calls. The `agent_runs`, `agent_reasoning_traces`, `agent_run_steps`, `agent_saga_steps` tables exist (6 migrations) but are populated only by the agent router infrastructure, not by any agent that exhibits autonomous behavior.

2. **Gate checks 9.5 and 11.5**. Documented as "all persisted into the `gate_checks` snapshot" (CLAUDE.md), but `PaymentIntentService.gateDeps()` (`PaymentIntentService.ts:316–329`) does not wire `resolveEvidence` or `detectDuplicates`. Both checks record as `{ not_applicable: true }` on every payment execution. The CLAUDE.md specifically names these as v0.4 additions that were implemented. They exist in the gate logic but are not connected to the service.

3. **Spend window rate limiting**. The policy VM accepts `spend_in_window` and `tx_count_in_window` from the caller (by design: the VM stays pure). But the `policy_spend_counters` table that would feed these values to the caller is missing due to the broken migration. Any policy rule using `agent.spend_in_window.lte` or `agent.tx_count_in_window.lte` will receive zeroed values, effectively disabling the cap.

4. **Reservation double-spend protection (gate check 8)**. `gateDeps()` omits `sumActiveReservations`. The gate check uses `"0"` as the reserved amount. `ledger_reservations` table exists and is properly migrated, but nothing reads it during gate evaluation.

### 8.2 Abandoned / Pending Architecture

5. **Legacy v0.2 routes**. `/execution/*` routes (`services/execution/src/routes.ts`) are retained for back-compat. They co-exist with v0.3 `/payment-intents/*` routes, creating a dual-path system. The `proposals` table (pre-H-04 design) still exists alongside `ledger_payment_intents`. These are documented as intentional but represent architectural debt.

6. **Outbound webhook retry queue**. `WebhookAuditEmitter` fires webhooks fire-and-forget. `BullMQ brain.audit.webhookDispatch` worker is marked as planned follow-up in CLAUDE.md. Dead letter table (`webhook_dead_letters`) exists but is not drained.

7. **`@brain/sdk`**. Generated, versioned, documented, but not published. External consumers cannot use it.

8. **Python payment and anomaly agents**. Migration 0008_agent_runs.sql and surrounding infra were built for these agents. They are explicitly called "later stages" in `brain_agents/__init__.py:5`.

### 8.3 Misleading Documentation

9. **"16 sequential checks" (CLAUDE.md)**. The gate has 17 numbered check positions (13 integer + 4 .5-variant). The gate comment itself says "13 checks." The CLAUDE.md says "16 sequential checks... plus v0.4 additions." No count matches. A minor documentation inconsistency but confusing for new contributors.

10. **Parent workspace CLAUDE.md says "five-layer"**. The parent `/home/sanketdebnath/Work/brain.inc/CLAUDE.md` says "five-layer financial intelligence protocol." The brain-core CLAUDE.md correctly notes this is stale ("the codebase is six layers as of v0.3"). But the contradiction in the workspace root is misleading.

---

## 9. Runtime Risk Areas

### 9.1 Scaling Risks

- **Single process monolith**: All six layers share one Node.js event loop. A slow wiki pgvector query or a hung anchor broadcaster will delay payment intent operations. No back-pressure between layers.

- **Anchor publisher runs in-process**: The hourly `setInterval` anchor broadcaster runs inside the main process. If it blocks (slow RPC, Base network issue), it occupies the event loop. Should be a separate worker.

- **Outbox worker integration tests blocked**: Worker comments say "the real FOR UPDATE SKIP LOCKED claim, the crash-injection recovery, and the concurrent-claim race require Postgres and are covered by an integration test (blocked in this sandbox)." The integration tests for the most critical worker path are not running.

### 9.2 Concurrency Risks

- **Double-spend vulnerability (gate check 8, reservation sub-check)**: `sumActiveReservations` is not wired. Parallel executions against the same account will both see the full `available_balance` and both pass check 8 independently. Both will then transition to `dispatching` and enqueue outbox rows. Only one will win the `approved → dispatching` atomic transition (conditional UPDATE); the other will abort. But between the gate passing and the atomic hand-off, there is a window where two identical payments could both clear the gate. The conditional update is the actual race guard. But check 8 no longer serves as a pre-rejection safeguard.

- **Duplicate payment guard disabled (check 11.5)**: With `detectDuplicates` not wired, an agent can create and execute two identical PaymentIntents against the same counterparty with the same amount. There is no pre-execution rejection for duplicates. The `ledger_payment_intents_dedup_key` unique index (migration 0014) provides database-level idempotency for creation, but not for execution.

### 9.3 Security Risks

- **RLS not enforced**: A single-tenant breach could read all tenant data. The policies exist (the `current_setting('app.tenant_id', true)` pattern is correctly applied in every migration), but they are bypassed because `FORCE ROW LEVEL SECURITY` has not been applied and services connect as the table owner.

- **MCP cross-service DB read**: `McpAuthVerifier` queries the `agents` table directly. If the execution service ever applies schema migrations that change the `agents` table structure, the MCP auth query silently breaks or produces incorrect results.

- **`BRAIN_MCP_DEV_AUTH_BYPASS` leakage**: The guard requires `NODE_ENV=production` to reject the bypass. If a staging environment runs with `NODE_ENV=staging` and `BRAIN_MCP_DEV_AUTH_BYPASS=true`, the full on-chain auth chain is skipped silently.

### 9.4 Orchestration Risks

- **Python agent `brain_api_base_url` default is `:3001`**: The TS API runs on port 3000. The Python agent config defaults to `localhost:3001`. In any environment where `BRAIN_API_BASE_URL` is not explicitly set, the Python agent's `propose()` calls will fail with "connection refused."

- **`agentService` optional in MCP**: If the boot wiring omits `agentService` from `McpServerDeps`, `agent.action.propose` tool calls return 500 with no clear error. This is a silent configuration error.

- **Anchor broadcaster uses `brain_privileged` implicitly**: The anchor publisher reads across tenants. The `withTenantScope` call in `publishAnchor` requires the connection to be privileged. In dev (single `brain` user), this works because the owner bypasses RLS. In production with proper role separation, the anchor publisher needs the `brain_privileged` connection. But the `DATABASE_URL` vs `PRIVILEGED_DATABASE_URL` split is not wired.

### 9.5 Maintainability Risks

- **`main.ts` 51,267 bytes, 1,319+ lines**: The boot binary is a monolithic composition file. It initializes every service layer, starts all background workers, and wires demo endpoints. This is a maintenance burden and a common source of hard-to-trace boot failures.

- **Parallel v0.2/v0.3 routes**: `POST /execution/{id}/execute` (v0.2) and `POST /payment-intents/{id}/execute` (v0.3) coexist. The v0.3 routes on the `services/execution/src/server.ts` factory have a `Deprecation: true` header. In main.ts, both route families are mounted. The mapping between `proposals` (v0.2) and `ledger_payment_intents` (v0.3) is undocumented.

---

## 10. Architectural Drift

### Changes since prior audit (`a6ed66e`, 2026-05-19)

The prior audit was on `feat/poc-investor-demo` at commit `a6ed66e`. Key changes in main:

- 3 new ledger migrations (0017_normalization_log_rls, 0018_payment_intents_dedup, 0019_payment_intents_dispatching_status). Reflecting gate check improvements and the `dispatching` status for H-04
- `policy/0003_policy_spend_counters.sql` appears to be new (the prior audit did not flag it as broken). This is a **regression introduced since the prior audit**
- `ledger_reservations` table now exists (0015); the reservation sub-check remains unwired

The three P0s closed in the prior audit (Dockerfile, SDK auth, anchor broadcaster) remain closed in main. All prior P0/P1 findings (gate checks 9.5/11.5, duplicate split, real rails) remain open.

### Documentation Drift

- **`Brain_MVP_Architecture.md` is v0.4**. Refers to six-layer model as current. Execution implementation matches.
- **`docs/agent-autonomy-v3.md`**. Describes "agent autonomy" with planning, memory, retries. The code does not implement this. The document is aspirational, not descriptive.
- **`docs/mcp-architecture.md`**. Claims 10 tools, 5 resources, 5 prompts. Verified as accurate.
- **`docs/boot-binary-spec.md`**. Describes single-process composition. Accurately describes the DESIGN; does not reflect the broken build.
- **`Brain_Engineering_Standards.md` §6**. Says gate checks are gated by the spec. Accurate except for the three unwired sub-checks (9.5, 11.5, 8-reservation).

---

## 11. Recovery Plan

### 11.1 Immediate Stabilization (P0. Blocks all deployments)

**P0-1: Fix main.ts compilation**

- Remove `"src/main.ts"` from `services/api/tsconfig.json:exclude`
- `main.ts` references instrumentation which initializes OTLP before other imports. A separate `tsconfig.main.json` with `"module": "NodeNext"` or bundler step may be needed.
- Alternatively, change the Dockerfile to use `tsx` as the runtime: `ENTRYPOINT ["tsx", "src/main.ts"]` (already works in dev).
- **Verify:** `node services/api/dist/main.js` starts without MODULE_NOT_FOUND.

**P0-2: Fix migration `policy/0003_policy_spend_counters.sql`**

- Rename column `window` → `period_window` (or `bucket_window`) throughout the SQL, the TypeScript `policy_spend_counters` service code, and the policy VM
- `window` is a PostgreSQL reserved keyword; it cannot be used as a bare column name without quoting
- **Verify:** `node tools/migrate/dist/cli.js up` completes without errors; `\d policy_spend_counters` shows the table

**P0-3: Apply RLS enforcement (production pre-deploy)**

- Run `infra/db-roles.sql` against the production database as a superuser
- Create `brain_app` (NOBYPASSRLS) and `brain_privileged` (BYPASSRLS) roles
- Update `DATABASE_URL` to use `brain_app`; create `PRIVILEGED_DATABASE_URL` for `brain_privileged`
- Wire the anchor publisher, normalize worker, Plaid webhook resolver, SIWX registry, and audit emitter to use `brain_privileged`
- **Verify:** Confirm `relforcerowsecurity = t` on all tenant-scoped tables; tenant A cannot read tenant B's data

### 11.2 Structural Fixes (P1. Correctness blockers)

**P1-1: Wire missing gate dependencies**

- In `PaymentIntentService.gateDeps()` (`PaymentIntentService.ts:316–329`), add:
  - `resolveEvidence`: load from policy service's evidence validator
  - `detectDuplicates`: load from policy service's `DuplicateDetector` (service already exists: `services/policy/src/duplicate-detector.ts`)
  - `sumActiveReservations`: query `ledger_reservations` via the `@brain/ledger` facade
- **Verify:** A payment with duplicate fingerprint is rejected (check 11.5 fails); a payment against insufficient reserved balance is rejected (check 8 accounting); evidence-unsupported payments fail check 9.5

**P1-2: Fix MCP cross-service DB violation**

- `McpAuthVerifier.loadAgent()` must go through the execution/agent service API, not a direct SQL query
- Option: expose `GET /internal/agents/{id}` on the execution service; call it from MCP auth
- Option: move agent registration/lookup to a shared mechanism in `@brain/shared`
- **Verify:** Removing the `pool` from `McpAuthVerifier` constructor forces an API-based lookup

**P1-3: Fix Python agent `brain_api_base_url` default**

- `services/agents/brain_agents/config.py`: change default from `localhost:3001` → `localhost:3000`
- Requires env var `BRAIN_API_BASE_URL` to be documented in docker-compose
- **Verify:** Python reconciliation agent can POST to `/v1/execution/propose` and get a response

**P1-4: Fix Python agent container crash**

- Diagnose why the lifespan fails (likely `OPENAI_API_KEY` or `BRAIN_API_TOKEN` not set)
- Add required env vars to docker-compose.yml and document required secrets
- Add startup exception handling that logs the missing var name before crashing
- **Verify:** `docker compose ps agents` shows `(healthy)` after boot

### 11.3 Layer Repairs (P2. Architecture integrity)

**P2-1: Complete JSON Schema coverage**

- Add JSON Schemas for the 6 missing entity types: balance, document, invoice, transfer, reconciliation_match, reservation (and payment_intent)
- Enforce schema validation in Ledger write helpers (currently only 6 of 12 entity types are schema-validated)

**P2-2: Wire `agentService` into MCP boot**

- Confirm `McpServerDeps.agentService` is injected at boot in `main.ts`. If it is currently absent in some boot paths, make it a required dependency.

**P2-3: Separate anchor broadcaster to a background process**

- Move the `setInterval` anchor broadcaster out of `main.ts` into a standalone worker
- This prevents anchor RPC latency from affecting the request-serving event loop

**P2-4: Decommission v0.2 execution routes (or document clearly)**

- Decide whether `/execution/*` routes are still supported
- If yes: document the mapping from `proposals` table to `ledger_payment_intents`
- If no: add deprecation sunset date, redirect to v0.3

### 11.4 Rewrite Candidates

**No full rewrites recommended at this stage.** The core primitives (gate, policy VM, audit chain, MCP) are correctly implemented. The missing pieces are missing wiring, not missing architecture.

The `services/api/src/main.ts` (51KB, 1,319+ lines) warrants modularization. Not a rewrite, but extraction of boot concerns into a dedicated boot module that composes plugins in a testable, inspectable way.

### 11.5 Long-Term Architecture Recovery

1. **Make agent autonomy real or rename it:** Either implement planning loops, LLM tool calls, and state persistence in the internal agent handlers. Or rename them "routing handlers" in all documentation. The current gap between documentation and implementation erodes trust.

2. **Implement real payment rails end-to-end:** The Plaid Transfer integration (`AchPlaidRail`) and on-chain execution (`OnchainBaseRail`) code exists and is unit-tested. Wire the live SDK clients into `defaultRails()` behind feature flags. Without real rails, the system cannot demonstrate its core value proposition.

3. **Deploy and verify RLS in a staging environment:** Before any real multi-tenant usage, run `infra/db-roles.sql`, configure the dual-connection model, and verify with a cross-tenant query attempt that returns 0 rows.

4. **Implement the Python agent layer:** The reconciliation agent is a valid proof of concept. Extending it to payment and anomaly detection agents would complete the "three MVP agents" story. Each needs `OPENAI_API_KEY`, `BRAIN_API_BASE_URL`, `BRAIN_API_TOKEN` in the environment.

5. **Close gate check gaps systematically:** Gate checks 9.5, 11.5, and the reservation sub-check are already designed and implemented in the gate logic. The missing piece is the three dependency injections in `PaymentIntentService.gateDeps()`. This is a one-sprint fix with high security impact.

---

_Audit completed: 2026-05-25. Next recommended review after P0 blockers are resolved._
