# brain-core Audit Index

**Started:** 2026-05-26
**Branch:** `audit/full-system-audit`
**Mapped from:** `main` HEAD `ff6d046` (audit branch merged `origin/main` at `daf2c63` before audit #15)
**Prior monolithic baseline:** [`_archive/2026-05-25-runtime-reality-audit.md`](./_archive/2026-05-25-runtime-reality-audit.md)

---

## Charter

This audit determines what brain-core **actually is** — not what it claims to be. The codebase and runtime behaviour are the source of truth. Documentation, architecture diagrams, and folder names are hypotheses, not facts.

Every conclusion must be backed by a file path, command result, or runtime trace. Confidence levels are mandatory. Production-readiness scores are mandatory. Speculative analysis is not allowed.

This is not a style review, lint review, or documentation review. It is an engineering reality audit: what works, what is scaffolded, what is fake, what is incomplete, what is dangerous.

---

## System Map

Start here before reading any subsystem report: [`system-map.md`](./system-map.md)

The system map covers: workspace inventory, runtime entrypoints (one Node process, one Python container), deploy units, six-layer architecture map, dependency graph, external integrations, migration ownership, queue/scheduler surfaces, MCP surface, smart-contract surface, invariant lints, and confidence-tagged unknowns.

---

## Subsystem Audit Reports

Each row is one audit turn. Status updates as turns complete.

| # | Report | Area | Status | Key question |
|---|---|---|---|---|
| 1 | [`runtime/boot.md`](./runtime/boot.md) | Runtime | `complete` | Build requires root build first (stale dist/); 2 pool handles leak on shutdown; `agent-router`+`internal-agents` missing from tsconfig refs; `wiki.annotate` MCP tool throws 500. Score: 6/10. |
| 2 | [`database/migrations-and-rls.md`](./database/migrations-and-rls.md) | Database | `complete` | P0 #2 confirmed (period_window present, comment documents rename). P0 #3: 43/44 tables have FORCE from migrations; `tenants` table missing FORCE migration (api schema), covered by db-roles.sql loop. R-14 mitigated: discover.ts .sort() ensures deterministic order; runner uses service/filename key so no bookkeeping collision. New: rls-coverage.test.ts blind to owner_id-keyed ledger tables. Live DB: CI-only. Score: 7/10. |
| 3 | [`services/api.md`](./services/api.md) | Services | `complete` | 80/80 spec routes wired. Dual PaymentIntentService: `piService` (HTTP path) missing `resolveTenantFlags` → gate check 1.5 (behavior hash) silently skipped for all HTTP `/payment-intents/{id}/execute` callers. MCP `wiki.annotate` still throws 500 (F-10, R-16). `RECONCILIATION_AGENT_URL` bypasses zod config (F-8). Score: 7/10. |
| 4 | [`services/raw-and-ledger.md`](./services/raw-and-ledger.md) | Services | `complete` | Normalize pipeline non-operational (R-19): no writer to `raw_parsed`; normalizeWorker perpetual no-op. `plaid@^27` in raw is dead dep (R-17). Duplicate 0004 migration prefix (R-18). 211 tests pass. Score: 7/10. |
| 5 | [`services/wiki.md`](./services/wiki.md) | Services | `complete` | Q&A orchestrator functional (Ledger-grounded, cached, evidence-filtered). Rate-limiter holds. wiki-no-ledger-write CI guard passes. `IWikiMemoryService.annotate` stub confirmed (R-16). Zero integration tests. Score: 7/10. |
| 6 | [`services/policy.md`](./services/policy.md) | Services | `complete` | VM correct (compareDecimal BigInt, property-tested). On-chain quorum enforced, fail-closed. H-23 action allowlist defined but NOT wired (`isActionAllowed` absent from ActionResolver). Spend counter increment never fires — aggregate caps read-only. `tenant.category` hardcoded "business". Score: 7/10. |
| 7 | [`services/execution.md`](./services/execution.md) | Services | `complete` | Outbox durable (H-04, atomic hand-off, stale reclaim). ApprovalService fully hardened (P0.4). Sagas correct but no production callers (R-23). ACH webhook settlement unwired — `applyPlaidTransferEvent` never called (R-24). R-20 reconfirmed (piService missing `resolveTenantFlags`). Score: 7/10. |
| 8 | [`orchestration/agent-router-and-routing-pipeline.md`](./orchestration/agent-router-and-routing-pipeline.md) | Orchestration | `complete` | Routing engine correct, 19 agents real. Payment agent live on ACH+onchain. Three wiring gaps: no domain event producers (R-25), empty evidence gatherer (R-26), worker path missing run persistence (R-27). Score: 6/10. |
| 9 | [`mcp/runtime.md`](./mcp/runtime.md) | MCP | `complete` | 10 tools confirmed, auth chain correct, 4/5 resources correct. `brain://ledger/obligations/{id}` always 404 (R-29). Cross-service DB read in auth.ts present but RLS-mitigated (R-28). Score: 7/10. |
| 10 | [`services/audit.md`](./services/audit.md) | Services | `complete` | Hash chain correct (FOR UPDATE, SHA-256, append-only enforced). Merkle tree correct (keccak256, property-tested). Publisher idempotent. Reconciler correct. Anchor broadcaster hardcoded to `baseSepolia` — mainnet blocked (R-30). Dead-letter queue present; no auto-retry (R-9 partial). Score: 6/10. |
| 11 | [`contracts/foundry.md`](./contracts/foundry.md) | Contracts | `complete` | 68/69 tests pass. `test_updateBehaviorHash_rejectsNonSigner` fails — potential behavior-hash access-control bypass (R-31). `viemScopeChecker.ts` ABI missing `behaviorHash` field — on-chain scope check always returns null when activated (R-32). Anchor ABI and SmartAccount ABI aligned. Score: 5/10. |
| 12 | [`agents/python.md`](./agents/python.md) | Agents | `complete` | 1 of 3 MVP agents (reconciliation only). Healthcheck broken (`curl` absent from `python:3.12-slim`). Empty `OPENAI_API_KEY` crashes lifespan — confirmed root cause of R-5 UNHEALTHY. Port mismatch 3001 vs TS API 3000. No auth on route. Score: 6/10. |
| 13 | [`sdk/clients-sdk.md`](./sdk/clients-sdk.md) | SDK | `complete` | 120 tests pass, typecheck clean. Codegen drift confirmed (479 lines / 27 hunks). `codegen:check` not in CI — drift accumulates silently. Zero internal consumers; e2e uses handwritten client. Not published. Score: 6/10. |
| 14 | [`infrastructure/terraform-and-compose.md`](./infrastructure/terraform-and-compose.md) | Infrastructure | `complete` | Container App target port 8080 vs API port 3000 (staging unreachable). Terraform injects 4 of ~20 required env vars (auth/rails all fail). frontdoor.tf missing. No Postgres private endpoint. Remote state commented out. Score: 5/10. |
| 15 | [`security/auth-rls-crypto-secrets.md`](./security/auth-rls-crypto-secrets.md) | Security | `complete` | JWT production JWKS + demo HS256 boot-guarded. RLS correct (FORCE on all schemas, non-owner probe fixed PR #23). AES-256-GCM auth tag enforced. Gap: `BRAIN_SOURCE_CREDENTIAL_KEY` optional with no production boot guard (F-15-A). DB connection role not verified at boot (F-15-B). Adversarial 10 vectors pass in CI; not in `pr.yml` (F-15-C). Score: 7/10. |
| 16 | [`architecture/six-layer-reality.md`](./architecture/six-layer-reality.md) | Architecture | `pending` | Do the six layers exist in practice? What are the violations? |
| 17 | [`technical-debt/findings.md`](./technical-debt/findings.md) | Technical Debt | `pending` | Roll-up: what must be fixed before production, what is acceptable debt? |

---

## Risk Register

Risks are seeded from the prior baseline and updated as each turn re-verifies or refutes them. **Do not treat these as confirmed without the corresponding subsystem audit.**

| ID | Risk | Severity | Verified? | Subsystem Report |
|---|---|---|---|---|
| R-1 | **P0 #2 remediated?** `period_window` rename in `services/policy/migrations/0003_policy_spend_counters.sql` — code committed, live DB unverified | High | Code: yes. Live DB: no | `database/migrations-and-rls.md` |
| R-2 | **P0 #3 remediated?** Force-RLS on 6 service schemas — 6 migration files committed; `infra/db-roles.sql` must be applied; `pg_class.relforcerowsecurity` unverified | High | Code: yes. Live DB: no | `database/migrations-and-rls.md` |
| R-3 | **MCP cross-service DB access** — prior audit: `services/mcp/src/auth.ts:117` queried execution's `agents` table directly, violating §1 | Low (was High) | Confirmed — violation present but RLS-mitigated (see R-28) | `mcp/runtime.md` |
| R-4 | **Payment rails live wiring** — `AchPlaidRail` + `OnchainBaseRail` have real implementations; live SDK construction and integration verification explicitly deferred (per CLAUDE.md) | High | Code: yes. Integration: no | `services/execution.md`, `integrations/` |
| R-5 | **Python agents UNHEALTHY** — prior audit: crash loop (likely missing `OPENAI_API_KEY`, wrong `brain_api_base_url` default `localhost:3001` vs TS API on 3000) | High | Unverified (no Docker) | `agents/python.md` |
| R-6 | **Plaid version skew** — `api` uses `plaid@^42`, `raw` uses `plaid@^27`; 15 major versions apart | Medium | Confirmed (code) | `services/raw-and-ledger.md`, `integrations/` |
| R-7 | **Per-service Dockerfiles non-runnable** — `CMD` targets `dist/main.js` with no standalone entrypoint; CI build-only | Medium | Confirmed (code) | `infrastructure/terraform-and-compose.md` |
| R-8 | **Root tsconfig missing agent-router + internal-agents** — these packages are not in the root project reference graph | Medium | Confirmed (code) | `runtime/boot.md` |
| R-9 | **Webhook retry queue missing** — `WebhookAuditEmitter` is fire-and-forget; BullMQ retry worker is planned, not implemented | Medium | Confirmed (CLAUDE.md) | `schedulers/`, `queues/` |
| R-10 | **SDK unpublished** — `@brain/sdk` at `0.1.0-rc.0`; not on npm | Low | Confirmed | `sdk/clients-sdk.md` |
| R-11 | **Python agent stubs** — Plaid extractor, payment agent, anomaly agent not implemented | Medium | Confirmed (CLAUDE.md) | `agents/python.md` |
| R-12 | **Gate checks 9.5/11.5 `not_applicable` when loaders unwired** — per prior audit; CLAUDE.md now lists these as implemented but `not_applicable` when loader is absent | Medium | Partially — needs re-check | `services/execution.md` |
| R-13 | **`anchorBroadcaster` wrong path in prior audit** — prior audit cited `services/audit/src/`; actual: `services/api/src/anchorBroadcaster.ts` | Low (doc error) | Confirmed corrected | `schedulers/background-jobs.md` |
| R-14 | **Duplicate `0004_*` migration prefix in `services/raw`** — `0004_force_rls.sql` and `0004_raw_plaid_items_rls.sql` share the same sequence number. `discover.ts` calls `.sort()` explicitly so order is deterministic (FORCE before ENABLE — valid in Postgres); runner uses `service/filename` key so no bookkeeping collision. Risk is MITIGATED but the duplicate prefix is cosmetically unclean and discover tests lack a regression for this. | Medium (was High) | Confirmed mitigated (code) | `database/migrations-and-rls.md` |
| R-15 | **Pool connection leak on graceful shutdown** — `privilegedPool` (outbox worker, BYPASSRLS) and `wikiPool` (wiki reader role) are created conditionally at boot but never closed in `shutdown()`. Production deploys use both separate pools, so leaks are guaranteed on every SIGTERM. | High | Confirmed (code) | `runtime/boot.md` |
| R-16 | **`wiki.annotate` MCP tool always returns 500** — the `IWikiMemoryService.annotate` implementation unconditionally throws `internal_server_error`. Any MCP client invoking this tool receives a 500 with no indication the stub is intentional. | Medium | Confirmed (code) | `runtime/boot.md` |
| R-17 | **Per-service typecheck broken without root build** — `pnpm --filter @brain/api typecheck` emits 16 errors on a fresh checkout; only resolves after `pnpm run build`. If CI doesn't enforce build-before-typecheck ordering, the errors are misleading. | Medium | Confirmed (code) | `runtime/boot.md` |
| R-18 | **`tenants` table missing FORCE migration** — `services/api/migrations/` has `ENABLE ROW LEVEL SECURITY` on `tenants` (0001) but no FORCE migration. Dev environments running only `tools/migrate up` without `infra/db-roles.sql` have an unforced tenant registry. Production is covered by the `db-roles.sql` DO $$ loop. Fix: add `api/migrations/0003_force_rls.sql`. | Medium | Confirmed (code) | `database/migrations-and-rls.md` |
| R-19 | **`rls-coverage.test.ts` blind to `owner_id`-keyed ledger tables** — static scanner regex checks `\btenant_id\b` in CREATE TABLE bodies; all 13 ledger tables use `owner_id` as isolation column and are invisible to the test. A new ledger table without ENABLE would pass CI undetected. | Low | Confirmed (code) | `database/migrations-and-rls.md` |
| R-20 | **Gate check 1.5 (behavior hash) absent on HTTP payment-intent execute path** — `piService` at `main.ts:1294` omits `resolveTenantFlags`; the §6 gate skips check 1.5 entirely for all `POST /v1/payment-intents/{id}/execute` and `POST /v1/actions/{id}/execute` HTTP callers. Tenants with `require_behavior_hash=true` have the flag enforced only for agent/MCP/worker-initiated executions. **Fix:** add `resolveTenantFlags` to `piService` deps at `main.ts:1294`. | Medium | Confirmed (code) | `services/api.md` |
| R-21 | **Spend counter increment never fires** — `incrementSpendCounter` is exported from `@brain/policy` but has zero call sites across the entire codebase. The gate reads spend-window counters to evaluate `agent.spend_in_window` and `agent.tx_count_in_window` rules, but never increments them after a successful execution. Aggregate spend caps look real in the VM but are structurally bypassed — every agent call sees the same counter values forever. **Fix:** call `incrementSpendCounter` inside the gate's live execution path (`dryRun === false` branch), within the same DB transaction as the policy-decision INSERT. | High | Confirmed (code — grep, no call site found) | `services/policy.md` |
| R-22 | **H-23 per-agent action allowlist not wired** — `PolicyDocument.agent_actions` and `allowedActionsFor()` are defined in `@brain/policy`. The `ActionResolver` accepts an optional `isActionAllowed` hook. But `main.ts:1092` constructs `ActionResolver` without the hook; the comment explicitly defers this as "Until wired, an explicit action is accepted if the agent offers it (pre-H-23 behavior)." The signed policy's per-agent action restrictions have no runtime enforcement. **Fix:** inject `isActionAllowed` into `ActionResolver` at `main.ts:1092` using a per-request load of the tenant's active policy via `policyGetActive`. | Medium | Confirmed (code) | `services/policy.md` |
| R-23 | **Saga executor never called in production** — `runSaga` is correctly implemented (compensates in reverse, emits audit events), exported from `@brain/execution`, and has 3 passing unit tests. The `agent_action_sagas` and `agent_saga_steps` DB tables exist (migration 0016, FORCE RLS). But `runSaga` has zero production call sites — not called from any service, route, or worker. Saga persistence is explicitly deferred to "the caller's concern" (comment in `sagas.ts:12`), but no caller exists. **Fix:** before introducing any multi-step agent flow that needs compensation, wire `runSaga` with a persistence wrapper that writes to `agent_action_sagas` / `agent_saga_steps`. | Medium | Confirmed (code — zero call sites found) | `services/execution.md` |
| R-24 | **ACH webhook settlement unwired** — `applyPlaidTransferEvent` is defined at `rails/ach-plaid.ts:218` and exported at `index.ts:47`, designed to be called by the `/raw/webhooks/plaid` handler on `TRANSFER_EVENTS_UPDATE` events. Neither `services/api/src/main.ts` nor `services/raw/` has any reference to it. The real `AchPlaidRail.dispatch()` returns `status: 'pending'` (asynchronous settlement); the terminal state arrives via Plaid webhook. With the webhook handler unconnected, any ACH payment intent dispatched via the real Plaid rail stays in `dispatching` until the outbox exhausts 3 retries and routes to `reconciling`. No money is lost (Plaid holds the transfer), but every ACH payment requires manual ops closure. Only active when `PLAID_CLIENT_ID` + `PLAID_SECRET` are configured. **Fix:** in the Plaid webhook handler at `/raw/webhooks/plaid`, resolve `transfer_id → outbox_id` and call `applyPlaidTransferEvent`. | High | Confirmed (code — no call sites found) | `services/execution.md` |
| R-25 | **Domain event producers are integration markers, not calls** — `emitDomainEvent()` from `shared/src/events/triggers.ts` has zero production call sites. `PaymentIntentService.reject()` and `ReconciliationService.runMatchers()` each contain a comment block describing where `emitDomainEvent` would be called (marked "INTEGRATION POINT, Phase 1: wiring is a follow-up"). The 36-event vocabulary, BullMQ `brain.agent.route` queue, and the `createAgentRouteWorker` are all in place; the queue is perpetually idle. **Fix:** add `enqueue: RoutingEnqueue` dep to `PaymentIntentService` and `ReconciliationService`, replace the integration-marker comments with `await emitDomainEvent(this.deps.enqueue, ...)` calls. | High | Confirmed (code — grep found only comments) | `orchestration/agent-router-and-routing-pipeline.md` |
| R-26 | **Evidence gatherer unwired — confidence structurally suppressed** — `agentEvidence = new StaticEvidenceGatherer()` at `main.ts:1048` provides a fixed empty set for all routing calls. The `ServiceEvidenceGatherer` is implemented and designed to pull Wiki citations + Ledger references; the TODO comment acknowledges the deferral. With zero evidence, `bundle.completeness = 0` for all agents, so `confidence = 0.6 * matchQuality + 0.15 * reputation`. The payment agent's `minimum_confidence: 0.85` requires a trigger match + evidence to reach `autonomy` execution mode; without evidence, it is structurally forced to `notify_only`. The §6 gate's evidence-presence check (check 11) will also reject autonomously-triggered payment proposals. **Fix:** instantiate `ServiceEvidenceGatherer` with the existing `wikiService` citation method and a `LedgerService` reference query at `main.ts:1048`. | High | Confirmed (code — StaticEvidenceGatherer with empty set) | `orchestration/agent-router-and-routing-pipeline.md` |
| R-27 | **Event-driven worker path missing run persistence** — `createAgentRouteWorker` calls `routeAndPropose()` (`worker.ts:61`), which does not accept a `store` parameter and records no `agent_routing_decisions` or `agent_runs` DB rows. The HTTP path (`POST /agents/run`) uses `AgentRunService.run()` which persists both rows. Event-triggered routing leaves no persistent audit trail beyond the in-flight `agent.router.*` audit events. **Fix:** either have the worker use `AgentRunService.run()` (preferred — eliminates the two-code-path divergence), or add a `store` parameter to `routeAndPropose()`. | Medium | Confirmed (code — two separate code paths, routeAndPropose has no store) | `orchestration/agent-router-and-routing-pipeline.md` |
| R-28 | **MCP auth cross-service direct DB read** — `McpAuthVerifier.loadAgent()` (`auth.ts:116`) queries the `agents` table directly via the shared pool using `withTenantScope`. The `agents` table is owned by `@brain/execution`; `@brain/mcp` depends on `@brain/execution` at the workspace level but bypasses `IAgentService.getAgent()` (which does not exist). Mitigations: RLS is active (withTenantScope), query is read-only, auth is in the hot path. Architectural violation (cross-service direct DB read) but operationally safe. **Fix:** add `getAgent(ctx, id)` to `IAgentService`, implement in `AgentService`, and have `McpAuthVerifier` call it instead. | Low | Confirmed (code — direct SELECT from agents in auth.ts:117) | `mcp/runtime.md` |
| R-29 | **`brain://ledger/obligations/{id}` resource always returns 404** — `resources.ts:97` calls `ctx.ledger.listObligations(ctx.ctx, { limit: 1 })` then `list.items.find((o) => o.id === parsed.id)`. With `limit: 1`, only the first row is fetched — if the requested obligation is not that row, the find returns `undefined` and the handler throws `ledger_row_not_found`. Root cause: `ILedgerService` has no `getObligation(ctx, id)` method. `readResource` has zero test coverage so this bug is invisible to CI. **Fix:** add `id` to `ObligationListFilters` in `ILedgerService` (or a dedicated `getObligation`), update `resources.ts`, and add an integration test for `readResource`. | Medium | Confirmed (code — limit:1, ILedgerService contract verified) | `mcp/runtime.md` |
| R-30 | **Anchor broadcaster hardcoded to `baseSepolia`** — `services/api/src/anchorBroadcaster.ts` uses `chain: baseSepolia` (chain ID 84532) in all three viem client constructions. No configurable chain parameter exists. `RPC_URL` defaults to `https://sepolia.base.org`. A production deployment with a mainnet `BASE_RPC_URL` and mainnet `AUDIT_ANCHOR_ADDRESS` will still submit anchor transactions to Sepolia — the anchor will fail silently (wrong chain ID, wrong contract address). On-chain audit verification against Base Mainnet is impossible until this is corrected. **Fix:** add `chainId`/chain env var (`AUDIT_ANCHOR_CHAIN: "base" | "base-sepolia"`, default `"base-sepolia"`), resolve the viem `Chain` object at boot, and pass it to `createViemAnchorBroadcaster` + `createViemAnchorEventReader`. | High | Confirmed (code — three `chain: baseSepolia` occurrences in anchorBroadcaster.ts) | `services/audit.md` |
| R-31 | **`updateBehaviorHash` access control regression** — Forge test `test_updateBehaviorHash_rejectsNonSigner()` in `BrainMCPAgentRegistry.t.sol` fails: `[FAIL: next call did not revert as expected]` at gas 246559 (write-path level). Static analysis shows the access control branch at line 172 is structurally correct, but the test proves a non-signer key can complete the write. Root cause requires `forge test -vvvv` tracing. **Security impact:** if confirmed, any caller can update an agent's `behaviorHash`, defeating §6 gate check 1.5 (behavior pinning). **Fix:** `forge test -vvvv --match-test test_updateBehaviorHash_rejectsNonSigner` → inspect recovered address → fix `_hashBehaviorUpdate` or EIP-712 digest divergence. | High | Confirmed (Forge test output) | `contracts/foundry.md` |
| R-32 | **`viemScopeChecker.ts` ABI missing `behaviorHash` — on-chain scope check always fails** — `BRAIN_MCP_AGENT_REGISTRY_ABI` defines 6 tuple components; the Solidity `AgentRegistration` struct has 7 (missing `behaviorHash` between `scopeHash` and `registeredAt`). ABI decoding is positional: `registration.registeredAt` reads from the `behaviorHash` slot (non-zero bytes32); `registration.revokedAt` reads from the `registeredAt` slot (non-zero timestamp). The check `revokedAt !== 0n` is always true → `getOnchainScopeHash` always returns `null` → MCP agent auth fails for 100% of agents when the real `ViemOnchainScopeChecker` is activated. **Currently latent** (stub wired in production). **Fix:** add `{ name: "behaviorHash", type: "bytes32" }` after `scopeHash` in `viemScopeChecker.ts` line 22. | Critical (latent) | Confirmed (code — 6 vs 7 fields, positional decode proven) | `contracts/foundry.md` |
| R-33 | **`BRAIN_SOURCE_CREDENTIAL_KEY` optional in production with no boot guard** — config declares the key `.optional()`; `main.ts` branches on its presence. A production deployment without the key silently stores Plaid credentials as plaintext JSON in `raw_plaid_items`. A TODO in `aes-gcm.ts` acknowledges the missing guard. **Fix:** add boot throw in `main.ts` when `NODE_ENV=production && cfg.BRAIN_SOURCE_CREDENTIAL_KEY === undefined`. | Medium | Confirmed (code) | `security/auth-rls-crypto-secrets.md` |
| R-34 | **DB connection role not verified at boot** — `main.ts` reads `DATABASE_URL` without asserting the connection is `brain_app` (NOBYPASSRLS). A superuser connection bypasses RLS even with FORCE ROW LEVEL SECURITY (`pg_catalog` superusers are unconditionally exempt). **Fix:** add a post-pool-connect check `SELECT current_user` and throw in production if not a recognized non-owner role. | Medium | Confirmed (code) | `security/auth-rls-crypto-secrets.md` |
| R-35 | **Adversarial suite (10 attack vectors) not wired in `pr.yml`** — a security regression in any of the 10 vectors passes PR CI and is only detected post-merge on `main`. **Fix:** add `pnpm -C tests/adversarial run test` to `pr.yml` (no DATABASE_URL required). | Low | Confirmed (workflow diff) | `security/auth-rls-crypto-secrets.md` |

---

## Unresolved Unknowns

Items from `system-map.md` §12 that require specific investigation:

1. **P0 RLS enforcement live** — requires `psql` against a migrated DB; CI-only.
2. **Python container health** — requires Docker.
3. **`anchorBroadcaster` activation path** — requires `AUDIT_ANCHOR_ADDRESS` + Base RPC + funded wallet.
4. **MCP auth.ts:117 cross-service DB access** — code trace needed in `mcp/runtime.md`.
5. **BullMQ exact queue names** — requires reading worker source files.
6. **Domain event bus subscribers** — RESOLVED: `createAgentRouteWorker` is the only consumer (`brain.agent.route` BullMQ queue). `shared/src/events/bus.ts` (pg_notify path) is infrastructure; BullMQ is the actual mechanism. Zero producers exist in service code (R-25).
7. **Plaid v42/v27 API surface incompatibility** — requires checking which v27-specific methods `services/raw` uses.
8. **On-chain + Plaid rail live integration** — explicitly deferred per CLAUDE.md; scope of deferral unclear.

---

## Audit File Template

Every subsystem audit MUST follow this 11-section structure. Copy this template for each new report.

```markdown
# Audit: <subsystem name>

**Audited:** <date>
**Files examined:** <list>
**Commands run:** <list>

---

## 1. Scope
What this report covers and what it explicitly does not cover.

## 2. Intended Architecture
What the subsystem appears designed to do — from docs, CLAUDE.md, interfaces.

## 3. Actual Implementation
What is truly implemented — derived from reading source code, not docs.

## 4. Runtime Validation
Commands executed with actual output.
Evidence from builds, tests, execution traces, imports, consumers.

## 5. Functional Status
Use exactly one of:
- Working
- Mostly Working
- Partial
- Broken
- Stubbed
- Dead Code
- Misleading Abstraction

Brief justification.

## 6. Architectural Violations
Evidence of layer leakage, circular deps, business logic in transport, tight coupling,
bypassed abstractions, duplicated orchestration, god services.
If none found: state "None found" with the evidence basis.

## 7. Missing Pieces
List: TODO systems, fake interfaces, mock-only paths, incomplete orchestration,
missing persistence, runtime gaps, deferred work.

## 8. Evidence
Concrete evidence: files, imports, call chains, consumer traces,
command output snippets, grep results.

## 9. Confidence Level
Use: High / Medium / Low
One paragraph explaining why.

## 10. Production Readiness
Score: 0–10
Explain: blockers, risks, failure modes, missing operational guarantees.

## 11. Refactor Priority
Use: Critical / High / Medium / Low
Justify.
```

---

*This index is updated after each subsystem turn completes. Risk register items are marked Verified when the corresponding report provides live evidence. The system-map is the authoritative structural reference.*
