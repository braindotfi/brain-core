# Audit: Runtime Boot. `services/api/src/main.ts`

**Audited:** 2026-05-26
**Branch:** `audit/full-system-audit`
**Files examined:**

- `services/api/src/main.ts` (1677 lines)
- `services/api/src/anchorBroadcaster.ts`
- `services/api/tsconfig.json`
- `services/api/tsconfig.typecheck.json`
- `services/api/tsconfig.main.json`
- `tsconfig.json` (root)
- `services/api/package.json`
- `shared/src/config.ts` (selected fields)
- `services/execution/src/approvals/ApprovalService.ts` (selected)
- `services/execution/src/deps.ts` (selected)
- `services/wiki/src/deps.ts` (selected)

**Commands run:**

- `pnpm --filter @brain/api typecheck` (before root build)
- `pnpm run build`
- `pnpm --filter @brain/api typecheck` (after root build)
- `pnpm --filter @brain/api build` (before root build. Fails)
- grep traces across main.ts, tsconfig files, shared/src/config.ts

---

## 1. Scope

This report covers:

- The `services/api/src/main.ts` boot sequence as the single composition root for all TS services
- Fastify plugin registration order (security → shared → routes)
- Worker startup and ordering (normalize, outbox, agent-route, anchor broadcaster)
- Boot-time guards and production fences
- Graceful shutdown completeness
- TypeScript build graph integrity for the composition root
- Environment variable validation coverage

Out of scope: the correctness of individual service layer logic (covered in per-service reports), Python agents container boot (covered in `agents/python.md`), and live infrastructure reachability (blocked by BLOCKERS.md B-1).

---

## 2. Intended Architecture

`main.ts` is documented as `brain-server`. The single binary that composes all six service layers into one Fastify process. From the file header:

> "Composes all six service layers into a single-process Fastify app. Shared plugins (auth, error handler, request-id, idempotency) are registered ONCE on the root app; each service layer registers its routes as a Fastify plugin on top."

Intended composition order per `docs/boot-binary-spec.md` reference:

1. Tracing init (OTLP)
2. Shared infra: connection pool, Redis, audit emitter, blob adapter
3. Service layer deps objects (Raw, Ledger, Wiki, Policy, Execution, Audit)
4. Fastify app: security → shared plugins → service routes under `/v1`
5. Background workers: normalize, outbox, anchor broadcaster, agent-route
6. HTTP listen

---

## 3. Actual Implementation

### Boot sequence (line references are main.ts)

**Phase 1. Infra (lines 547–680)**

1. `loadConfig()`. Zod-validated env config (throws on missing required vars)
2. `initTracing()`. OTLP setup; non-blocking, no connection required at boot
3. `createLogger()`
4. `createPool()` → main DB pool (`DATABASE_URL`)
5. `createPool()` → `wikiPool`. Conditional: only if `BRAIN_WIKI_DB_URL` is set; falls back to main pool with `console.warn` (line 583)
6. `new Redis(...)` with `lazyConnect: true` + `redis.connect()` at line 590. **Redis connection is eagerly awaited** at boot; failure here aborts boot before HTTP listener registers
7. `new WebhookAuditEmitter(new PostgresAuditEmitter(pool), new WebhookDispatcher(pool))`. Audit emitter composed
8. **Production guards** (lines 597–608): three explicit `throw` checks. DEMO_MODE in prod, MCP_DEV_AUTH_BYPASS in prod, BLOB_BACKEND=memory in prod
9. Blob adapter creation
10. `createPool()` → `privilegedPool`. Conditional: only if `DATABASE_PRIVILEGED_URL` set; falls back to main pool with `console.warn` (line 945)

**Phase 2. Service layer deps (lines 638–1194)**
All deps objects and service classes constructed synchronously. Key cross-service wiring:

- `LedgerService` used inside `makeResolveAccount` and `makeResolveCounterparty` (adapters for execution gate)
- `PolicyService.evaluateForGate` wired to `PaymentIntentService.evaluatePolicy`
- `WikiPageService` + `buildWikiMemoryService` adapter wires `annotate` stub → throws `internal_server_error` (annotate write-through not implemented, deferred to refactor-4, line 348–355)
- `BrainMcpServer` gets `auth: McpAuthVerifier` (real viem on-chain check) or `FakeAuthVerifier` when `BRAIN_MCP_DEV_AUTH_BYPASS` is set

**Phase 3. Fastify app and plugin registration (lines 1196–1558)**
Plugin registration order (inside `main()`):

1. `fastifyCors` (origin allowlist from `CORS_ALLOWED_ORIGINS`)
2. `registerSecurityHeaders`. CSP + security headers (P1.4 hardening)
3. `fastifyRateLimit` (max 300 req/min global)
4. `requestIdPlugin`, `errorHandlerPlugin`, `authPlugin`, `idempotencyPlugin`. Registered once on root app
5. `GET /health`. `skipAuth: true`, always available
6. All service routes under `/v1` via `app.register(async (v1) => {...}, { prefix: "/v1" })`:
   - Raw, Ledger, Wiki, Policy, Execution, PaymentIntent, Audit, Webhook, Proof, ProofView, MCP, AgentApi, SIWX
   - Demo-only routes (`/v1/demo/token`, `/v1/demo/policy/activate`, `/v1/demo/anchor/trigger`) added when `BRAIN_DEMO_MODE=true`
   - Production guard for `AUTH_SIGN_KEY` happens inside v1 registration (line 1377). Deferred guard, not at top of `main()`

**Phase 4. Workers and background jobs (lines 1561–1628)**
Workers start **before** `app.listen()` (line 1630):

1. `startNormalizeWorker({ pool, audit })` (line 1561). BullMQ worker consuming `brain.normalize` queue
2. Anchor broadcaster setup (lines 1563–1608). Conditional on `AUDIT_ANCHOR_ADDRESS` and `AUDIT_PUBLISHER_KEY`; if configured, schedules periodic anchor publishing via `setTimeout` loop
3. `createAgentRouteWorker(...)` (line 1616). BullMQ worker consuming `brain.agent.route` queue

`startOutboxWorker` is created earlier at line 961 (before Fastify app creation). This is the only worker that starts before app construction.

**Phase 5. HTTP listen and shutdown handlers (lines 1630–1671)**

- `app.listen({ host: "0.0.0.0", port: cfg.PORT })`
- `process.on("SIGINT")` and `process.on("SIGTERM")` → `shutdown()`

---

## 4. Runtime Validation

### Pre-build typecheck (FAIL)

```
$ pnpm --filter @brain/api typecheck

src/main.ts(30,3): error TS2305: Module '"@brain/shared"' has no exported member 'RedisSlidingWindowRateLimiter'.
src/main.ts(111,3): error TS2305: Module '"@brain/execution"' has no exported member 'resolveInvoiceShortcut'.
src/main.ts(115,3): error TS2305: Module '"@brain/execution"' has no exported member 'InvoiceShortcutInvoice'.
src/main.ts(116,3): error TS2305: Module '"@brain/execution"' has no exported member 'ResolvedInvoiceShortcut'.
src/main.ts(180,3): error TS2305: Module '"@brain/shared"' has no exported member 'GateTenantFlags'.
src/main.ts(508,32): error TS7006: Parameter 'c' implicitly has an 'any' type.
src/main.ts(508,35): error TS7006: Parameter 'id' implicitly has an 'any' type.
src/main.ts(522,32): error TS7006: Parameter 'c' implicitly has an 'any' type.
src/main.ts(528,35): error TS7006: Parameter 'c' implicitly has an 'any' type.
src/main.ts(737,5): error TS2353: Object literal may only specify known properties, and 'annotationRateLimiter' does not exist in type 'WikiDeps'.
src/main.ts(739,18): error TS2339: Property 'WIKI_ANNOTATION_RATE_PER_HOUR' does not exist on type '{...}'.
src/main.ts(805,5): error TS2353: Object literal may only specify known properties, and 'isApproverActive' does not exist in type 'ApprovalServiceDeps'.
src/main.ts(877,5): error TS2353: Object literal may only specify known properties, and 'resolveTenantFlags' does not exist in type 'PaymentIntentServiceDeps'.
src/main.ts(922,5): error TS2353: Object literal may only specify known properties, and 'resolveTenantFlags' does not exist in type 'ExecutionDeps'.
src/main.ts(1290,11): error TS2353: Object literal may only specify known properties, and 'isApproverActive' does not exist in type 'ApprovalServiceDeps'.
src/main.ts(1308,61): error TS2554: Expected 2 arguments, but got 3.
src/sandbox/resolvers.ts(24,8): error TS2305: Module '"@brain/shared"' has no exported member 'GateTenantFlags'.
Exit status 2
```

**Root cause:** `tsconfig.typecheck.json` maps only `@brain/shared` to source (`../shared/src/index.ts`); all other packages (`@brain/execution`, `@brain/wiki`, etc.) resolve from `node_modules/<pkg>/dist/`, which are stale until rebuilt. When `shared/`, `execution/`, `wiki/` ship new exports or type changes (hardening additions: `RedisSlidingWindowRateLimiter`, `GateTenantFlags`, `isApproverActive`, `resolveTenantFlags`, `annotationRateLimiter`, `resolveInvoiceShortcut`), the `dist/` files lag until a root build runs.

### Root build (PASS)

```
$ pnpm run build

Scope: 12 of 22 workspace projects
shared build: Done
clients/sdk build: Done
services/audit build: Done    services/ledger build: Done
services/raw build: Done      services/policy build: Done
services/wiki build: Done     services/internal-agents build: Done
services/execution build: Done
services/agent-router build: Done
services/mcp build: Done
services/api build: Done
```

All 12 in-scope packages compile successfully in dependency order.

### Post-build typecheck (PASS)

```
$ pnpm --filter @brain/api typecheck
(no output. Exit 0)
```

All 16 pre-build errors resolve after fresh dist/ files are generated.

### Build graph. Root `tsconfig.json`

```
services/api  ✓
services/raw  ✓
services/ledger ✓
services/wiki ✓
services/policy ✓
services/execution ✓
services/mcp ✓
services/audit ✓
services/api/tsconfig.main.json ✓
clients/sdk ✓
services/agent-router  ✗ (MISSING)
services/internal-agents ✗ (MISSING)
```

`agent-router` and `internal-agents` are imported by `main.ts` (lines 142–164) but neither appears in `tsconfig.json` project references or in `tsconfig.main.json`'s `references` array. Both are compiled by the root build script (`pnpm -r --filter ...`), not by `tsc -b`. If `tsc -b` is used directly (e.g., `pnpm run typecheck`), these packages may not rebuild on source changes.

---

## 5. Functional Status

**Mostly Working**

The boot sequence is structurally sound and the root build passes cleanly. All six service layers and both BullMQ workers and the agent-route worker compose and register correctly. The Fastify plugin order (security → shared → routes) is correct.

Key qualification: the per-service typecheck is broken without a prior root build (16 errors), which creates a silent "works if you run the right thing first" fragility. Two pool handles (`wikiPool`, `privilegedPool`) are not closed in the shutdown handler, creating connection leaks on graceful shutdown. One environment variable (`RECONCILIATION_AGENT_URL`) bypasses config validation. Three features are conditionally silenced at boot with `console.warn` rather than startup assertions (`BRAIN_WIKI_DB_URL`, `DATABASE_PRIVILEGED_URL`, `AUDIT_PUBLISHER_KEY`).

---

## 6. Architectural Violations

### B-1: `RECONCILIATION_AGENT_URL` bypasses validated config (main.ts:1097)

```typescript
const reconciliationAgentUrl = process.env.RECONCILIATION_AGENT_URL;
```

All other environment variables go through `loadConfig()` (a zod-validated schema in `shared/src/config.ts`). This one is read directly from `process.env`. It is not documented in `config.ts`, receives no type coercion, no URL validation, and no schema presence. If misconfigured (wrong URL format, missing trailing slash), the error surfaces at request time, not boot time.

This is a minor but reproducible convention break. The codebase has a clear pattern (`loadConfig()`) which this line ignores.

### B-2: Deferred production guard inside v1 plugin registration (main.ts:1377)

```typescript
if (cfg.NODE_ENV === "production" && cfg.AUTH_SIGN_KEY === undefined) {
  throw new Error("AUTH_SIGN_KEY must be set in production ...");
}
```

This guard is inside the `v1.register()` callback. Fastify plugin registration is asynchronous. The three guards at lines 597–608 throw at the top of `main()` (immediate); this one throws inside async plugin registration. While Fastify propagates plugin errors to the `main().catch()` handler (and the process exits), the boot timeline is non-deterministic relative to the earlier guards. In practice, this is a low-severity ordering issue, not a correctness bug.

### B-3: `wiki.annotate` stub throws `internal_server_error` (main.ts:348–355)

```typescript
async annotate(_ctx, _input): Promise<...> {
  throw brainError("internal_server_error", "wiki.annotate not yet wired in boot binary");
}
```

`IWikiMemoryService.annotate` is exposed in the `BrainMcpServer` surface (tool: `wiki.annotate`). Calls to this MCP tool return HTTP 500 with an `internal_server_error` code. This is documented as "deferred to refactor-4" but constitutes a broken tool in the published MCP surface. An external agent invoking `wiki.annotate` receives a 500 with no indication this is expected behavior.

---

## 7. Missing Pieces

### M-1: `privilegedPool` not closed in shutdown handler (High)

`privilegedPool` is created at line 937 when `DATABASE_PRIVILEGED_URL` is set:

```typescript
privilegedPool = createPool({ connectionString: cfg.DATABASE_PRIVILEGED_URL, max: 3, ... });
```

The shutdown handler (lines 1634–1663) calls `pool.end()` but never `privilegedPool.end()`. On SIGTERM/SIGINT, the 3 outbox-worker connections to the privileged DB will be abandoned. The Postgres server will see the client disconnect during query (if in-flight) or clean up via TCP timeout otherwise. In production, the `DATABASE_PRIVILEGED_URL` pool is always distinct from the main pool, so the leak is guaranteed on every graceful shutdown.

### M-2: `wikiPool` not closed in shutdown handler (Medium)

Same pattern: `wikiPool` is created at line 576 when `BRAIN_WIKI_DB_URL` is set. The shutdown handler never calls `wikiPool.end()`. Wiki-layer connections to the read-only `brain_wiki_reader` role will be abandoned on shutdown.

### M-3: `agent-router` and `internal-agents` missing from tsconfig project references (Medium)

Confirmed as R-8. `tsconfig.main.json` lists references: api, raw, ledger, wiki, policy, execution, audit, mcp. `tsconfig.json` (root) lists: api, raw, ledger, wiki, policy, execution, mcp, audit, api/main, clients/sdk. Both omit `agent-router` and `internal-agents`. This means `tsc -b` (incremental build) will not detect type changes in those packages and will serve stale declarations until a full `pnpm run build` is run.

### M-4: `wiki.annotate` not wired (Medium)

Documented stub at main.ts:348. Any MCP client calling `wiki.annotate` receives `internal_server_error`. The write-through path is explicitly deferred.

### M-5: `anchorBroadcaster` silently disabled without `AUDIT_PUBLISHER_KEY` (Low)

```typescript
const anchorBroadcaster =
  cfg.AUDIT_PUBLISHER_KEY !== undefined
    ? createViemAnchorBroadcaster({...})
    : undefined;
```

When `AUDIT_PUBLISHER_KEY` is not set, `anchorBroadcaster` is `undefined` and `auditDeps` is built without `broadcaster`. The on-chain Merkle anchor is not published. No warning is logged at boot (unlike `BRAIN_WIKI_DB_URL` and `DATABASE_PRIVILEGED_URL` which emit `console.warn`). The operator has no boot-time signal that anchoring is disabled.

### M-6: Per-service `PaymentIntentService` duplication (Low)

The outer `paymentIntentService` (line 870, used by outbox worker and agent run service) and an inner `piService` (line 1294, used by HTTP payment intent routes) are separate instances. Both use `new OutboxService()` as their outbox dep. `OutboxService` is stateless (writes to DB only), so this is not a correctness bug, but the comment at line 1285 ("doesn't share mutable state") suggests this was a deliberate defensive choice, not an architectural principle. A future `OutboxService` with state could silently break the separation guarantee.

---

## 8. Evidence

### Plugin registration order (verified from main.ts line numbers)

| Order | Plugin                    | Line      | Note                      |
| ----- | ------------------------- | --------- | ------------------------- |
| 1     | `fastifyCors`             | 1207      | CORS origin allowlist     |
| 2     | `registerSecurityHeaders` | 1209      | CSP + X-\* headers (P1.4) |
| 3     | `fastifyRateLimit`        | 1210      | 300 req/min global        |
| 4     | `requestIdPlugin`         | 1213      | Trace ID injection        |
| 5     | `errorHandlerPlugin`      | 1214      | Centralized error mapping |
| 6     | `authPlugin`              | 1215      | JWT + SIWX verification   |
| 7     | `idempotencyPlugin`       | 1217      | Redis-backed dedup        |
| 8     | `GET /health`             | 1222      | `skipAuth: true`          |
| 9–21  | Service routes            | 1276–1555 | All under `/v1` prefix    |

### Worker startup order (before `app.listen`)

| Worker                               | Start line | Stop in shutdown?                        |
| ------------------------------------ | ---------- | ---------------------------------------- |
| `startOutboxWorker`                  | 961        | Yes (`outboxWorker.stop()` line 1639)    |
| `startNormalizeWorker`               | 1561       | Yes (`normalizeWorker.stop()` line 1638) |
| Anchor broadcaster (setTimeout loop) | 1607       | Yes (`clearTimeout(anchorTimer)`)        |
| `anchorReconciler`                   | 994        | Yes (`anchorReconciler?.stop()`)         |
| `createAgentRouteWorker`             | 1616       | Yes (`agentRouteWorker.close()`)         |

`app.listen()` at line 1630. **all workers registered before HTTP starts**.

### Shutdown pool leak evidence

`shutdown()` function (lines 1634–1663):

```typescript
const shutdown = async (signal: string): Promise<void> => {
  ...
  normalizeWorker.stop();
  outboxWorker.stop();
  anchorReconciler?.stop();
  await agentRouteWorker.close();
  await app.close();
  await pool.end();      // main pool only
  redis.disconnect();
  await shutdownTracing();
  process.exit(0);
};
```

`wikiPool` (created line 576). **never closed**.
`privilegedPool` (created line 938). **never closed**.

### `RECONCILIATION_AGENT_URL` config bypass

`shared/src/config.ts`. No `RECONCILIATION_AGENT_URL` entry (verified via grep. Absent).
`main.ts:1097`. `process.env.RECONCILIATION_AGENT_URL` read directly.
All other optional URLs (`BRAIN_WIKI_DB_URL`, `DATABASE_PRIVILEGED_URL`, `BASE_RPC_URL`, etc.) are in the zod schema.

### `anchorBroadcaster` at `services/api/src/anchorBroadcaster.ts` (confirmed)

```typescript
// main.ts line 60:
import { createViemAnchorBroadcaster, createViemAnchorEventReader } from "./anchorBroadcaster.js";
```

File confirmed at `services/api/src/anchorBroadcaster.ts`. The prior monolithic audit's claim of `services/audit/src/anchorBroadcaster.ts` was incorrect.

### `anchorBroadcaster.ts` circular reference workaround (confirmed)

```typescript
// services/api/src/anchorBroadcaster.ts line 3-5:
// Inlined from @brain/audit to avoid a circular tsc project-reference:
// services/audit references ../api, so services/api cannot import @brain/audit.
```

The `AnchorBroadcaster` type and ABI are duplicated inline rather than imported from `@brain/audit`. This is a deliberate circular-import workaround. The duplication creates a maintenance surface: if the `BrainAuditAnchor` ABI changes in `services/audit`, the inlined ABI in `anchorBroadcaster.ts` will silently diverge.

---

## 9. Confidence Level

**High**

The entire `main.ts` file (1677 lines) was read directly. All line references are verified. Both the root build and per-service typecheck were executed with actual output captured. The plugin registration order, worker startup sequence, graceful shutdown, and production guards were traced by reading the source. Not inferred from documentation.

The only unverified aspects are live runtime behaviors (Redis connectivity, actual DB connections, worker queue consumption). Those require a running infra stack per BLOCKERS.md B-1.

---

## 10. Production Readiness

**Score: 6 / 10**

**What works:**

- Build passes cleanly after root build
- Fastify plugin order is correct (security before routes, auth before endpoints)
- Workers start before HTTP listener
- 4 production guards prevent obvious misconfigurations from booting
- Graceful shutdown covers the main pool, Redis, all workers, Fastify, and tracing

**Blockers:**

| ID  | Issue                                                                                         | Severity |
| --- | --------------------------------------------------------------------------------------------- | -------- |
| M-1 | `privilegedPool` not closed on shutdown. Guaranteed connection leaks in production            | High     |
| M-2 | `wikiPool` not closed on shutdown                                                             | Medium   |
| M-3 | `agent-router` + `internal-agents` missing from tsconfig references. Incremental build drift  | Medium   |
| B-1 | `RECONCILIATION_AGENT_URL` bypasses validated config. Silently misbehaves on misconfiguration | Low      |
| B-3 | `wiki.annotate` MCP tool returns `internal_server_error` in production                        | Medium   |
| M-5 | `anchorBroadcaster` silently disabled with no boot warning when key is absent                 | Low      |

**Runtime risks:**

- Redis is a hard boot dependency. No Redis → no boot. No circuit breaker, no retry at boot time.
- Per-service `pnpm --filter @brain/api typecheck` will return 16 errors on a fresh clone without root build. CI must run `pnpm run build` before any per-service typecheck step; if that ordering is not enforced, typecheck appears to pass (if the root build was previously cached) but is unreliable.
- The `anchorBroadcaster` ABI is inlined in `services/api/src/anchorBroadcaster.ts`. If the on-chain contract is upgraded, the inline ABI must be manually updated. No type-safe link to the canonical ABI source.

---

## 11. Refactor Priority

**High**

The two pool leak fixes (M-1, M-2) are two-line additions to the shutdown handler and should be done before production. The `RECONCILIATION_AGENT_URL` config bypass (B-1) is a one-line fix: add the variable to `shared/src/config.ts`. The tsconfig project reference gap (M-3) requires adding two entries to `tsconfig.main.json` and `tsconfig.json`. Low risk, high correctness value.

`wiki.annotate` (B-3) requires implementing the write-through path, which is a larger effort (refactor-4). The stub behaviour (returning 500) is known and deferred but constitutes a broken public MCP tool in any deployed instance.

The `anchorBroadcaster` ABI duplication is a maintenance debt item. Low refactor priority but should be tracked so it doesn't diverge from the Foundry contract.

---

## New Findings (Added to Cross-Cutting Register)

| ID   | Title                                                                                  | Severity | Status                      |
| ---- | -------------------------------------------------------------------------------------- | -------- | --------------------------- |
| F-7  | `privilegedPool` and `wikiPool` not closed in shutdown handler                         | High     | Open                        |
| F-8  | `RECONCILIATION_AGENT_URL` bypasses validated config                                   | Low      | Open                        |
| F-9  | `anchorBroadcaster` ABI inlined in `services/api`. Divergence risk from Foundry source | Low      | Open                        |
| F-10 | `wiki.annotate` MCP tool returns 500 in all deployments                                | Medium   | Open (deferred: refactor-4) |
| F-11 | Per-service typecheck requires prior root build (stale dist/ issue)                    | Medium   | Open                        |
