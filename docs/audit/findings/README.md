# Audit Area: Findings Register

**Scope:** Cross-cutting findings that span multiple subsystems. Issues that don't belong to a single area but represent systemic risks or architectural violations.

**This register is updated as each subsystem audit completes.** Each finding links back to the subsystem report that surfaced it.

**Format per finding:**
```
## F-<N>: <short title>

**Severity:** Critical / High / Medium / Low
**Surfaces in:** <list of audit areas>
**Status:** Open / Remediated / Deferred
**Summary:** One paragraph, evidence-cited.
**Links:** <subsystem report paths>
```

**Seed findings (pre-verified, carried forward from prior audit):**

### F-1: Cross-service DB access in MCP auth
**Severity:** High | **Status:** Open (unverified. Must re-check in `mcp/runtime.md`)
Prior audit: `services/mcp/src/auth.ts:117` queries execution's `agents` table directly. Violates §1: cross-service reads go through the owning service's API. If still present, this is an architectural violation.

### F-2: `anchorBroadcaster` path wrong in prior audit
**Severity:** Low (documentation error) | **Status:** Remediated (corrected here)
Prior audit cited `services/audit/src/anchorBroadcaster.ts`. Actual location: `services/api/src/anchorBroadcaster.ts`. Imported from `main.ts:60`.

### F-3: Plaid major-version skew
**Severity:** Medium | **Status:** Open
`services/api/package.json`: `plaid@^42.2.0`. `services/raw/package.json`: `plaid@^27.0.0`. Two workspaces in the same monorepo using Plaid SDK 15 major versions apart. API surface changes between v27 and v42 are significant. Must verify in `integrations/external-integrations.md`.

### F-4: Agent-router and internal-agents excluded from root tsconfig project graph
**Severity:** Medium | **Status:** Open
`/tsconfig.json` references: api, raw, ledger, wiki, policy, execution, mcp, audit, clients/sdk. Missing: `services/agent-router`, `services/internal-agents`. They build only via transitive dependency resolution; `pnpm -w tsc -b` may not type-check them in isolation.

### F-6: Duplicate migration sequence prefix in `services/raw`
**Severity:** High | **Status:** Open
`services/raw/migrations/` contains two files with prefix `0004_`: `0004_force_rls.sql` and `0004_raw_plaid_items_rls.sql`. The `tools/migrate` CLI discovers migrations via filesystem sort; two files sharing a sequence number will be applied in filesystem order, which is non-deterministic across environments and may cause RLS enforcement gaps or constraint conflicts depending on which runs first. Must be verified in `database/migrations-and-rls.md`.

### F-5: Per-service Dockerfiles reference non-existent standalone entrypoints
**Severity:** Medium | **Status:** Open (by design. Deferred)
Each per-service `Dockerfile` has `CMD ["node", "services/<name>/dist/main.js"]` but no standalone `main.ts` exists in those services (they boot via `services/api/src/main.ts`). The Dockerfiles validate the build graph in CI but cannot produce runnable containers today. Explicitly marked TODO in each Dockerfile.

---

## Findings from `runtime/boot.md` (2026-05-26)

### F-7: `privilegedPool` and `wikiPool` not closed in shutdown handler
**Severity:** High | **Status:** Open
**Surfaces in:** `runtime/boot.md`
`services/api/src/main.ts` creates `privilegedPool` (line 938, when `DATABASE_PRIVILEGED_URL` set, max 3 connections) and `wikiPool` (line 576, when `BRAIN_WIKI_DB_URL` set) but the `shutdown()` handler (lines 1634–1663) only calls `pool.end()`. The main pool. On SIGTERM/SIGINT, these pools abandon open Postgres connections. In production, `DATABASE_PRIVILEGED_URL` is always distinct from the main URL, so the leak is guaranteed on every graceful shutdown. **Fix:** add `await privilegedPool.end()` and `await wikiPool.end()` after `pool.end()` in `shutdown()`.

### F-8: `RECONCILIATION_AGENT_URL` bypasses validated config
**Severity:** Low | **Status:** Open
**Surfaces in:** `runtime/boot.md`
`main.ts:1097` reads `process.env.RECONCILIATION_AGENT_URL` directly instead of via `loadConfig()`. This variable is absent from `shared/src/config.ts` (zod schema). No URL validation, no type coercion, no boot-time schema presence. All other optional URLs in main.ts go through the zod config. A misconfigured value (malformed URL, wrong port) will surface at request time, not boot time.

### F-9: `anchorBroadcaster` ABI inlined in `services/api`. Divergence risk
**Severity:** Low | **Status:** Open
**Surfaces in:** `runtime/boot.md`
`services/api/src/anchorBroadcaster.ts` inlines the `BrainAuditAnchor` ABI (the `anchor` function) to avoid a circular tsc project reference (`@brain/audit` → `../api`). If the on-chain contract is upgraded and the canonical ABI in `contracts/src/` is changed, this inline copy must be manually updated. There is no build-time link to the Foundry ABI artifacts.

### F-10: `wiki.annotate` MCP tool returns 500 in all deployments
**Severity:** Medium | **Status:** Open (deferred: refactor-4)
**Surfaces in:** `runtime/boot.md`
The `IWikiMemoryService.annotate` implementation in `main.ts` (lines 348–355) unconditionally throws `brainError("internal_server_error", "wiki.annotate not yet wired in boot binary")`. Any MCP client calling the `wiki.annotate` tool receives HTTP 500 with error code `internal_server_error`. The tool is listed in the MCP surface (10 tools per CLAUDE.md) but is not functional. Deferred to refactor-4.

### F-11: Per-service typecheck requires prior root build
**Severity:** Medium | **Status:** Open
**Surfaces in:** `runtime/boot.md`
`pnpm --filter @brain/api typecheck` returns 16 type errors on a fresh checkout (or after any hardening run that adds exports to dependency packages) because `tsconfig.typecheck.json` maps only `@brain/shared` to source. Other packages resolve from their stale `dist/` files. The 16 errors resolve after `pnpm run build`. CI must ensure root build runs before any per-service typecheck step. The pre-build error output is misleading: it suggests missing exports that actually exist in source, which could cause developers to incorrectly diagnose the dependency packages as broken.

---

## Findings from `database/migrations-and-rls.md` (2026-05-26)

### F-12: `tenants` table missing FORCE ROW LEVEL SECURITY migration
**Severity:** Medium | **Status:** Open
**Surfaces in:** `database/migrations-and-rls.md`
`services/api/migrations/0001_tenants.sql` enables RLS on the `tenants` table but no api-service migration applies `FORCE ROW LEVEL SECURITY`. The `infra/db-roles.sql` DO $$ loop covers all RLS-enabled tables (including `tenants`) in production. However, in a development environment where only `tools/migrate up` is run without `db-roles.sql`, the table owner connects and bypasses RLS entirely on the tenant registry. The most security-critical table in the system (`id = current_setting('app.tenant_id', true)` is the root isolation predicate). **Fix:** add `services/api/migrations/0003_force_rls.sql` with `ALTER TABLE tenants FORCE ROW LEVEL SECURITY;`.

### F-13: `rls-coverage.test.ts` does not cover `owner_id`-keyed ledger tables
**Severity:** Low | **Status:** Open
**Surfaces in:** `database/migrations-and-rls.md`
`tests/invariants/src/rls-coverage.test.ts` finds tenant-scoped tables by scanning CREATE TABLE SQL for the regex `\btenant_id\b`. All 13 ledger tables (`ledger_accounts`, `ledger_balances`, etc.) use `owner_id` as their isolation column instead of `tenant_id`. Their RLS policies are correct (`USING (owner_id = current_setting('app.tenant_id', true))`), but the static invariant test is blind to them. A new ledger table added without ENABLE RLS would pass the CI check undetected. **Fix:** extend `rls-coverage.test.ts` to also match tables whose RLS policies reference `current_setting('app.tenant_id', true)`, regardless of column name.

---

## Findings from `services/api.md` (2026-05-26)

### F-14: HTTP `POST /payment-intents/{id}/execute` bypasses gate check 1.5 (behavior hash)
**Severity:** Medium | **Status:** Open
**Surfaces in:** `services/api.md`
`main.ts:1294` creates a second `PaymentIntentService` (`piService`) for the HTTP `/v1/payment-intents/*` routes. This instance omits `resolveTenantFlags` from its dependency set. `shared/src/gate/gate.ts:283-309` shows that when `deps.resolveTenantFlags` is `undefined`, gate check 1.5 (`agent_behavior_pinned`) is silently skipped. No gate_checks row is emitted for it, and the `tenants.require_behavior_hash` flag is never read. Agent-initiated executions (via MCP, agent run service, agent route worker, outbox worker) use the first `PaymentIntentService` instance (line 870) which DOES have `resolveTenantFlags` wired. A tenant with `require_behavior_hash=true` in the `tenants` table will find behavior-hash enforcement applied only for agent callers, not for direct human API callers. **Fix:** add `resolveTenantFlags` to the `piService` instantiation at `main.ts:1294`, matching line 877.

### F-15: `main()` composition function is 1130+ lines. No boundary between infra setup and route wiring
**Severity:** Low | **Status:** Open
**Surfaces in:** `services/api.md`
`services/api/src/main.ts` defines a single `main()` function spanning lines 546–1671 (≈1130 lines). All cross-service dependency wiring, pool construction, adapter setup, service instantiation, worker startup, route registration, and shutdown handling are inline in one function. There is no structural separation between infrastructure setup and HTTP registration. Future changes adding cross-service dependencies (e.g., a new gate check needing a new service reference) must be threaded through the entire function. Not a runtime risk today; a maintenance and testability risk as the system grows.
