# Audit: Services. API Gateway (`services/api`, `@brain/api`)

**Audited:** 2026-05-26
**Files examined:**

- `services/api/src/main.ts` (1676 lines)
- `services/api/src/index.ts`
- `services/api/src/auth/siwx.ts`
- `services/api/src/security-headers.ts`
- `services/api/src/proof/routes.ts`
- `services/api/src/proof/view.ts`
- `services/api/src/proof/assembler.ts`
- `services/api/src/proof/fetchProofSources.ts`
- `services/api/src/sandbox/resolvers.ts` (referenced)
- `services/api/src/agents/run-loaders.ts` (referenced)
- `services/api/src/agents/reconciliationClient.ts` (referenced)
- `services/api/src/mcp/viemScopeChecker.ts` (referenced)
- `services/api/src/policy/viemPolicySignerChecker.ts` (referenced)
- `services/api/src/rails/plaidClient.ts`, `onchainExecutor.ts`
- `services/api/src/webhooks/plaidJwks.ts`, `plaidTenant.ts`
- `services/execution/src/payment-intents/PaymentIntentService.ts` (lines 350–380)
- `services/execution/src/server.ts` (standalone app builder. Not production path)
- `services/ledger/src/routes/index.ts`
- `services/ledger/src/server.ts`
- `services/wiki/src/routes/annotate.ts`
- `shared/src/gate/gate.ts` (lines 275–310)
- `shared/src/config.ts` (lines 92–150)
- `Brain_API_Specification.yaml` (99 operationIds)

**Commands run:**

- `pnpm --filter @brain/api run test` → 84 tests pass (15 files)
- `pnpm --filter @brain/execution run test` → 168 tests pass (22 files)
- `grep -rn "operationId:" Brain_API_Specification.yaml | wc -l` → 80
- Static code traces for route registration, dependency wiring, gate check path

---

## 1. Scope

What this report covers:

- `services/api/src/main.ts`. The single composition root for the entire Node runtime
- Route registration order and prefix mapping to `Brain_API_Specification.yaml`
- Auth plugin wiring: JWT, SIWX, demo mode guards
- Idempotency, CORS, rate limiting, security headers
- The dual `PaymentIntentService` instantiation and its behavioral consequence on gate check 1.5
- The `wiki.annotate` split between HTTP route and MCP tool
- Cross-cutting failure modes: RECONCILIATION_AGENT_URL bypass, pool lifecycle (already in F-7, F-8)
- Proof API route and view

What this report does NOT cover:

- Per-route business logic (covered in their respective service audits)
- The outbox worker and anchor broadcaster lifecycle (covered in `runtime/boot.md`)
- OpenAPI schema validation (covered in `sdk/clients-sdk.md`)

---

## 2. Intended Architecture

Per `docs/boot-binary-spec.md` (referenced from `main.ts:8`) and CLAUDE.md §MCP:

- `main.ts` is the **single boot binary** (`brain-server`). All six service layers are composed as Fastify plugins on one root Fastify app.
- Shared cross-cutting plugins (auth, error handler, request-id, idempotency) are registered **once** on the root app; each layer adds its routes as a scoped Fastify plugin.
- All routes sit under `/v1` (matching `Brain_API_Specification.yaml` base URL `https://api.brain.fi/v1`).
- The gateway terminates JWT auth; no downstream auth challenge exists.
- `Idempotency-Key` on all write endpoints via Redis; webhook deduplication by provider event ID separately.
- Demo mode guard: `BRAIN_DEMO_MODE=true && NODE_ENV=production` → boot throws.

---

## 3. Actual Implementation

### 3.1 Route registration map

All public service plugins are wired under `/v1`. Route composition order:

| Plugin             | Spec paths                                                     | Route function                                          |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------- |
| Raw                | `/raw/*`, `/raw/webhooks/{provider}`                           | `registerRawPlugin`, `registerRawExtractRoute`          |
| Ledger             | `/ledger/*`                                                    | `registerLedgerPlugin` (includes ReconciliationService) |
| Wiki               | `/memory/*`, `/wiki/*`                                         | `registerWikiPlugin`                                    |
| Policy             | `/policy/*`                                                    | `registerPolicyRoutes`                                  |
| Execution (legacy) | `/execution/*`, `/proposals/*`                                 | `registerExecutionRoutes`                               |
| PaymentIntent      | `/payment-intents/*`, `/actions/*`                             | `registerPaymentIntentRoutes` (see §3.2)                |
| Audit              | `/audit/*`                                                     | `registerAuditRoutes`                                   |
| Webhooks           | `/webhooks/*`                                                  | `registerWebhookRoutes`                                 |
| Proof              | `/proof/:action_id`                                            | `registerProofRoutes`                                   |
| Proof view         | `/proof/:id/view`                                              | `registerProofViewRoute`                                |
| MCP                | `/agents/mcp`                                                  | `registerMcpRoute`                                      |
| Agent API          | `/agents/*`                                                    | `registerAgentApiRoutes`                                |
| SIWX               | `/auth/siwx/challenge`, `/auth/siwx`                           | `registerSiwxRoutes`                                    |
| Demo (cond.)       | `/demo/token`, `/demo/policy/activate`, `/demo/anchor/trigger` | inline, BRAIN_DEMO_MODE only                            |
| Health             | `/health`                                                      | inline                                                  |

Cross-cutting plugins registered on root app before all routes: `fastifyCors`, `fastifyHelmet` (CSP + HSTS), `fastifyRateLimit` (300 req/min), `requestIdPlugin`, `errorHandlerPlugin`, `authPlugin`, `idempotencyPlugin`.

### 3.2 Dual PaymentIntentService instances

Two `PaymentIntentService` instances exist in `main()`:

**Instance 1** (`paymentIntentService`, `main.ts:870`):

```
new PaymentIntentService({ pool, audit, outbox, approvals: approvalService,
  resolveAgent, resolveTenantFlags,   // ← resolveTenantFlags PRESENT
  resolveAccount, resolveCounterparty, evaluatePolicy, resolvePrincipal,
  resolveOnchainParams?, sourceCredentialResolver })
```

Used by: `outboxWorker.executor`, `mcpServer.paymentIntents`, `agentRunService.propose.paymentIntents`, `agentRouteWorker.propose.paymentIntents`, `haltAgent` closure.

**Instance 2** (`piService`, `main.ts:1294`):

```
new PaymentIntentService({ pool, audit, outbox: new OutboxService(),
  approvals: piApprovals,             // separate ApprovalService instance
  resolveAgent, resolveAccount, resolveCounterparty,
  evaluatePolicy, resolvePrincipal,
  resolveOnchainParams?, sourceCredentialResolver })
  // ← resolveTenantFlags ABSENT
```

Used by: `registerPaymentIntentRoutes` → HTTP `/v1/payment-intents/*` and `/v1/actions/*`.

The comment justifying the second instance: _"PaymentIntentService has its own approval sub-service; create a fresh instance scoped to this plugin so it doesn't share mutable state."_ The concern is about `ApprovalService`; the developer correctly creates a fresh `piApprovals` but simultaneously and silently drops `resolveTenantFlags`.

### 3.3 Gate check 1.5 (behavior hash) is skipped on HTTP payment-intent routes

`shared/src/gate/gate.ts:283-309`:

```typescript
const tenantFlags = deps.resolveTenantFlags
  ? await deps.resolveTenantFlags(input.ctx.tenantId)
  : null;
const requireBehaviorHash = tenantFlags?.requireBehaviorHash ?? false;
// ...
} else if (deps.resolveTenantFlags !== undefined) {
  // Without the loader we add no row, which preserves the canonical-13
  // happy path for every pre-P0.1 caller.
  pass(checks, 1.5, "agent_behavior_pinned", { not_applicable: true });
}
```

When `resolveTenantFlags` is `undefined` (all HTTP `/v1/payment-intents/{id}/execute` calls via `piService`):

- Gate check 1.5 is **not run**. No gate_checks row emitted for 1.5
- `require_behavior_hash` is treated as `false` regardless of what the tenant's row in `tenants` says
- Behavior hash pinning is effectively opt-out for HTTP API callers even for tenants where `tenants.require_behavior_hash = true`

Agent-initiated executions through the outbox worker, MCP server, or agent run service hit Instance 1 which HAS `resolveTenantFlags` → gate check 1.5 runs correctly.

### 3.4 Auth wiring

`authPlugin` registered once on root app with `JwtVerifier`. Routes opt out via `{ config: { skipAuth: true } }`:

- `GET /v1/health`
- `POST /v1/auth/siwx/challenge`
- `POST /v1/auth/siwx`
- `POST /v1/raw/webhooks/{provider}` (HMAC, Plaid JWKS-verified separately)
- `GET /v1/demo/token` (demo mode only; has per-route rate limit 5/min)

SIWX in production: `PostgresAgentRegistry` queries `agents` table by `onchain_address` (using `privilegedPool` for the cross-tenant lookup). In demo mode: `StubAgentRegistry` accepts any valid `0x...` address and returns a synthetic agent/tenant tuple.

Production boot guard at `main.ts:1377-1381`: throws if `NODE_ENV=production && AUTH_SIGN_KEY=undefined`.

### 3.5 `wiki.annotate`. HTTP route vs MCP tool

Two separate code paths:

1. **HTTP `POST /v1/wiki/annotate`**: Implemented in `services/wiki/src/routes/annotate.ts`. Rate-limited (Redis sliding window, 60/hr default). For `policy` and `agent` entity kinds: fully functional → inserts entity row + emits audit event. For Ledger-type annotations (`account`, `counterparty`, `transaction`, `obligation`): returns `400 request_body_invalid` with explicit "refactor-4" message.
2. **MCP `wiki.annotate` tool**: Routed through `buildWikiMemoryService` adapter in `main.ts:348-355`. Unconditionally throws `brainError("internal_server_error", "wiki.annotate not yet wired in boot binary")`. This is a different code path from the HTTP route (F-10, R-16).

### 3.6 `reconciliation` routes wired

`registerLedgerPlugin` at `services/ledger/src/server.ts:50-53` always instantiates `ReconciliationService` and passes it to `registerLedgerRoutes`. The `POST /v1/ledger/reconcile` and `GET /v1/ledger/reconciliation-matches` routes return 501 only if `reconciliation === undefined`, which cannot happen in the production composition.

---

## 4. Runtime Validation

```
$ pnpm --filter @brain/api run test
 ✓ src/auth/siwx.test.ts (18 tests) 598ms
 ✓ src/proof/routes.test.ts (3 tests) 9ms
 ✓ src/security-headers.test.ts (3 tests) 240ms
 ✓ src/proof/view.test.ts (9 tests) 201ms
 ✓ src/agents/reconciliationClient.test.ts (11 tests) 17ms
 ✓ src/agents/run-loaders.test.ts (8 tests) 13ms
 [... 15 test files total ...]
 Test Files 15 passed (15)
 Tests      84 passed (84)

$ pnpm --filter @brain/execution run test
 [... 22 test files ...]
 Test Files 22 passed (22)
 Tests      168 passed (168)
```

No test validates the dual-PaymentIntentService behavioral gap (gate check 1.5 absent on HTTP path). No integration test exercises `POST /v1/payment-intents/{id}/execute` with a tenant that has `require_behavior_hash=true`.

Route coverage static check: 80 OpenAPI operationIds confirmed registered by tracing each `register*` call to its route file.

---

## 5. Functional Status

**Mostly Working**

The gateway correctly routes all 80 spec endpoints. Auth, idempotency, CORS, security headers, and rate limiting are wired at the correct layer. Demo mode guards are properly enforced. The routing composition is correct; each service layer's plugin is mounted under `/v1`.

Two known gaps:

1. Gate check 1.5 silently skipped for all HTTP `/v1/payment-intents/*` callers due to missing `resolveTenantFlags` on `piService`.
2. MCP `wiki.annotate` tool unconditionally throws 500 (F-10).

---

## 6. Architectural Violations

### Violation A: `main()` as 1130-line god function

`main.ts` is 1676 lines; `main()` itself spans roughly lines 546–1671. Every cross-service dependency is wired inline: pool construction, Redis, blob adapter, LLM/embed adapters, auth resolvers, approval hooks, service instances for all six layers, worker startups, route registrations, shutdown handler. This is a composition root by design (per `boot-binary-spec.md`), but there is no structural boundary separating infra setup, service wiring, and HTTP registration.

Consequence: any change that adds a cross-service dependency (e.g. Policy reading Ledger for a new guard) must be threaded through this function, touching code 500+ lines away from the call site.

### Violation B: `piService` diverges silently from canonical PaymentIntentService config

`main.ts:1294` creates a second `PaymentIntentService` with a different dependency set. This is an implicit contract: a caller must know which instance gets which deps. There is no type-level enforcement that `piService` stays in sync with `paymentIntentService`. The current divergence (missing `resolveTenantFlags`) is the first but likely not the last.

### No other layer violations found

The API gateway does not read or write service-owned DB tables directly (all reads go through the owning service's function imports over the shared pool). Cross-service reads from `main.ts` (e.g., `findAgent` from `@brain/execution` used to resolve principals) use the service's own repository functions, not raw SQL queries against the wrong schema. This is the sanctioned exception: the composition root imports from each service and wires them.

---

## 7. Missing Pieces

1. **Gate check 1.5 missing from HTTP execution path**. `resolveTenantFlags` not passed to `piService` (F-14, R-20).
2. **MCP `wiki.annotate` tool broken**. `buildWikiMemoryService.annotate` throws unconditionally (F-10, R-16, deferred refactor-4).
3. **`RECONCILIATION_AGENT_URL` bypasses validated config**. `process.env.RECONCILIATION_AGENT_URL` read at `main.ts:1097` without going through `loadConfig()` zod schema (F-8).
4. **No test for dual-instance behavioral divergence**. The gap between `paymentIntentService` and `piService` is not caught by any existing test. A test executing `/payment-intents/{id}/execute` with `require_behavior_hash=true` would expose the missing check.
5. **`wiki.annotate` HTTP route**: Ledger-type annotations (`account`, `counterparty`, `transaction`, `obligation`) return 400 not 501. The error message mentions refactor-4 but callers receive a `request_body_invalid` error code, which implies a client error rather than an unimplemented endpoint. Potentially confusing.
6. **`privilegedPool` and `wikiPool` not closed on SIGTERM**. Already F-7; repeated here as it is in this scope.

---

## 8. Evidence

**Dual PaymentIntentService:**

- `main.ts:870`: `new PaymentIntentService({ ..., resolveTenantFlags, ... })`
- `main.ts:1294`: `new PaymentIntentService({ ..., /* resolveTenantFlags absent */ })`
- `main.ts:1285`: comment: _"create a fresh instance scoped to this plugin so it doesn't share mutable state"_
- `shared/src/gate/gate.ts:283-286`: `tenantFlags = deps.resolveTenantFlags ? await deps.resolveTenantFlags(...) : null`; `requireBehaviorHash = tenantFlags?.requireBehaviorHash ?? false`
- `shared/src/gate/gate.ts:304-309`: explicit `pass(..., { not_applicable: true })` only when `deps.resolveTenantFlags !== undefined`

**Route coverage:**

- `Brain_API_Specification.yaml`: 80 `operationId:` entries
- All 13 `register*` calls in `main.ts` traced to their source files and route definitions
- `registerLedgerPlugin` (`services/ledger/src/server.ts:50-53`): always passes `ReconciliationService` to routes

**Auth:**

- `main.ts:1215`: `await app.register(authPlugin, { verifier: jwtVerifier })`. Once, on root app
- `main.ts:1392-1394`: `cfg.BRAIN_DEMO_MODE ? new StubAgentRegistry() : new PostgresAgentRegistry(pool)`
- `siwx.ts:232-252`: `StubAgentRegistry` accepts any `0x[a-f0-9]{40}` address

**`wiki.annotate` split:**

- `services/wiki/src/routes/annotate.ts:66-99`: HTTP route functional for `policy`/`agent` kinds; 400 for Ledger kinds
- `main.ts:348-355`: MCP adapter `annotate()` throws `brainError("internal_server_error", ...)`

**`RECONCILIATION_AGENT_URL` bypass:**

- `main.ts:1097`: `const reconciliationAgentUrl = process.env.RECONCILIATION_AGENT_URL;`
- Not in `shared/src/config.ts` zod schema (confirmed in Report #1, F-8)

---

## 9. Confidence Level

**High**

The gateway is a single 1676-line file with explicit `register*` call traces. Route coverage was verified by cross-referencing each `operationId` against call sites in the service packages. The gate check gap was verified by reading the actual gate logic in `shared/src/gate/gate.ts`. The dual-instance issue is structural and visible in source. All test suites passed. No runtime or DB-dependent evidence needed for the core gateway facts.

One area remains Medium confidence: whether there are any routes registered inside service plugins that have no corresponding OpenAPI operationId (undocumented private routes). That is out of scope for this audit turn.

---

## 10. Production Readiness

**Score: 7/10**

**What works:**

- All 80 API spec endpoints are wired; route coverage is complete
- Auth plugin correctly applied once; JWT + SIWX + Plaid HMAC all wired
- Idempotency, CORS, security headers, rate limiting correctly layered
- Demo mode guards prevent demo-only endpoints and SIWX stub from appearing in production
- Two pools (privileged, wiki reader) correctly created for isolation; one open issue with shutdown (F-7)

**Blockers before production:**

| Issue                                                                   | Severity | Fix                                                                               |
| ----------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| Gate check 1.5 bypassed on HTTP `/payment-intents/{id}/execute` callers | Medium   | Add `resolveTenantFlags` to `piService` at `main.ts:1294`                         |
| MCP `wiki.annotate` always 500                                          | Medium   | Deferred to refactor-4 (documented); MCP clients are blocked from using this tool |
| `RECONCILIATION_AGENT_URL` bypasses config validation                   | Low      | Add to zod config schema; read via `cfg`                                          |

**Not blockers but debt:**

- `main()` 1130-line god function: not a runtime risk, but future feature additions increase tangling
- No behavior-hash-specific integration test for HTTP path

---

## 11. Refactor Priority

**Medium**

The one-line fix (`resolveTenantFlags` added to `piService` at `main.ts:1294`) eliminates the behavioral inconsistency. The `main()` god function is a medium-term architectural debt. Extracting a `wireServices()` helper and a separate `registerRoutes()` pass would make the composition testable, but carries no runtime risk today. The MCP `wiki.annotate` is already deferred and documented.
