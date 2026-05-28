# Audit: Database. Migrations and Row-Level Security

**Audited:** 2026-05-26
**Branch:** `audit/full-system-audit`
**Files examined:**
- `services/api/migrations/0001_tenants.sql`, `0002_tenants_default_ap_account.sql`
- `services/audit/migrations/0007_force_rls.sql`
- `services/execution/migrations/0019_force_rls.sql`, `0020_approvals_hardening.sql`
- `services/ledger/migrations/0003_ledger_accounts.sql`, `0020_force_rls.sql`
- `services/policy/migrations/0003_policy_spend_counters.sql`, `0004_force_rls.sql`
- `services/raw/migrations/0001_raw_artifacts.sql`, `0003_raw_plaid_items.sql`,
  `0004_force_rls.sql`, `0004_raw_plaid_items_rls.sql`, `0006_force_rls_sources.sql`
- `services/wiki/migrations/0006_force_rls.sql`
- `infra/db-roles.sql`
- `tools/migrate/src/discover.ts`, `runner.ts`, `discover.test.ts`, `runner.test.ts`
- `tests/invariants/src/rls-coverage.test.ts`, `tenant-isolation.test.ts`
- `tests/invariants/integration/db-invariants.integration.test.ts`

**Commands run:**
- `find services -name "*.sql" | sort`. Enumerated all migration files
- Node script static scan: counted tables with `tenant_id`, ENABLE, FORCE
- `pnpm --filter @brain/invariants run test`. Invariants test suite
- `pnpm -C tools/migrate run test`. Migrate tool unit tests
- `node -e "..."`. Verified lexicographic sort order of duplicate-prefix filenames

---

## 1. Scope

This report covers:
- P0 #2: `period_window` rename in `services/policy/migrations/0003_policy_spend_counters.sql`. Code-level confirmation
- P0 #3: Force-RLS on 6 service schemas. Migration coverage, role model (`infra/db-roles.sql`), static invariant tests
- R-14: Duplicate `0004_*` migration prefix in `services/raw`. Ordering analysis, runner key collision check
- Migration runner behavior (`tools/migrate/`). Discovery algorithm, bookkeeping, idempotency
- DB-free invariant test results; integration tests are CI-only (BLOCKERS.md B-1)

Does NOT cover:
- Live Postgres verification of `pg_class.relrowsecurity` / `relforcerowsecurity`. Requires DATABASE_URL (BLOCKERS.md B-1)
- Migration apply correctness against a real DB (ditto)
- Per-table RLS policy correctness (predicate logic). That is a security audit concern; see `security/auth-rls-crypto-secrets.md`

---

## 2. Intended Architecture

From CLAUDE.md §1 Principle 2:

> Tenant isolation at the storage layer: Postgres RLS on every table. Migrations *arm* RLS (`ENABLE ROW LEVEL SECURITY`), but it is only *enforced* under the role model in `infra/db-roles.sql`. A non-owner `brain_app` role plus `FORCE ROW LEVEL SECURITY`. Legitimate cross-tenant readers use the `brain_privileged` BYPASSRLS role.

The design splits enforcement into two layers:
1. **Migration layer**. `ENABLE ROW LEVEL SECURITY` + tenant_isolation policies authored per-table in `services/*/migrations/*.sql`. Also `FORCE ROW LEVEL SECURITY` in dedicated hardening migrations. Applied by `tools/migrate` CLI.
2. **Role model layer**. `infra/db-roles.sql` creates `brain_app` (NOBYPASSRLS, non-owner) and `brain_privileged` (BYPASSRLS). A DO $$ loop applies FORCE to all RLS-enabled tables as defense-in-depth. Applied once at DB deploy time by an operator.

P0 #2 and P0 #3 were the two prior blockers whose fixes landed in migrations; this turn re-verifies them at code level.

---

## 3. Actual Implementation

### Migration runner (`tools/migrate/`)

`tools/migrate/src/discover.ts` scans `services/*/migrations/*.sql`, filters by `FILENAME_RE = /^(\d{4,})_[a-z0-9_]+\.sql$/i`, then sorts:

```typescript
const files = (await readdir(mDir)).filter((f) => FILENAME_RE.test(f)).sort();
// ...
results.sort((a, b) => a.key.localeCompare(b.key));
```

The inner `.sort()` is per-service, lexicographic by filename. The outer sort is global, by `key = service/filename`. This ordering is fully deterministic and OS-independent.

The runner tracks applied migrations in `brain_migrations.key` (a `TEXT PRIMARY KEY` of `service/filename`). Each migration runs in an isolated `BEGIN`/`COMMIT`. A content SHA mismatch on a previously-applied migration raises an error rather than re-running. This enforces the §10.5 forward-compatible guarantee.

### P0 #2. `period_window` rename

`services/policy/migrations/0003_policy_spend_counters.sql:15`:
```sql
period_window TEXT NOT NULL,  -- '1h' | '24h' | '7d' | '30d'
```

Lines 6–7 document the reason:
```sql
-- Column renamed: 'window' → 'period_window' ('window' is a PostgreSQL reserved keyword
-- and caused a syntax error at CREATE TABLE time).
```

The column is consistently named `period_window` throughout the migration. The `UNIQUE` constraint on line 20 also uses `period_window`. The `CREATE INDEX` on line 23–24 also uses `period_window`. No residual `window` column reference exists in this file.

### P0 #3. Force-RLS coverage

Static scan of all service migration SQL (verified by node script, 2026-05-26):

| Service | ENABLE tables | FORCE migration | Tables FORCEd |
|---------|---------------|-----------------|---------------|
| api | tenants | *none* |. |
| audit | audit_events, audit_anchors, webhook_endpoints, webhook_dead_letters, domain_events | `0007_force_rls.sql` | 4 (not domain_events) |
| execution | agents, approvals, executions, proposals, users, and 12 more | `0019_force_rls.sql` | 17 (includes domain_events cross-service) |
| ledger | ledger_accounts, ledger_balances, … (13 tables using owner_id isolation) | `0020_force_rls.sql` | 13 |
| policy | policies, policy_decisions, policy_spend_counters | `0004_force_rls.sql` | 3 |
| raw | raw_artifacts, raw_parsed, raw_plaid_items, raw_sources | `0004_force_rls.sql` + `0006_force_rls_sources.sql` | 4 |
| wiki | wiki_entities, wiki_pages, wiki_relations | `0006_force_rls.sql` | 3 |

**Total tables with ENABLE: 44. Tables with FORCE from migrations: 43.**

**Gap: `tenants` table (api schema) has ENABLE from `0001_tenants.sql` but NO FORCE migration.** The `infra/db-roles.sql` DO $$ loop covers this:

```sql
FOR t IN
  SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ...
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
LOOP
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
END LOOP;
```

This loop applies FORCE to every RLS-enabled table. Including `tenants`. In production, this loop runs. In a development environment where only `tools/migrate up` is run without `infra/db-roles.sql`, the `tenants` table owner bypasses RLS.

**Secondary gap: ledger tables use `owner_id` not `tenant_id`** as the isolation column. `ledger_accounts:9`: `owner_id TEXT NOT NULL`, and `USING (owner_id = current_setting('app.tenant_id', true))`. The RLS policies are correct, but the static invariant test `rls-coverage.test.ts` searches for `\btenant_id\b` in CREATE TABLE bodies. It misses all ledger tables entirely. All ledger tables DO have ENABLE+FORCE, so there is no current security gap, but the test offers no coverage assertion for the ledger schema.

### R-14. Duplicate `0004_*` prefix in `services/raw`

The two conflicting files:
- `services/raw/migrations/0004_force_rls.sql`. `FORCE ROW LEVEL SECURITY` on `raw_artifacts`, `raw_parsed`, `raw_plaid_items`
- `services/raw/migrations/0004_raw_plaid_items_rls.sql`. `ENABLE ROW LEVEL SECURITY` + 3 policies on `raw_plaid_items`

Confirmed sort order (Node.js `Array.prototype.sort`):
```
[ '0004_force_rls.sql', '0004_raw_plaid_items_rls.sql', '0005_raw_sources.sql' ]
```

So `0004_force_rls.sql` always runs first. It applies `FORCE ROW LEVEL SECURITY` on `raw_plaid_items` before that table has ENABLE or policies. In Postgres, `ALTER TABLE ... FORCE ROW LEVEL SECURITY` is valid on a table without RLS enabled. It sets `relforcerowsecurity = true` but has no effect until ENABLE is also set. Then `0004_raw_plaid_items_rls.sql` runs: enables RLS and creates policies. End state: `relrowsecurity = true` AND `relforcerowsecurity = true`. This is correct.

The `brain_migrations` bookkeeping records these as:
- `key = raw/0004_force_rls.sql`
- `key = raw/0004_raw_plaid_items_rls.sql`

No key collision. The runner applies both without conflict.

**Root cause of R-14**: `0004_raw_plaid_items_rls.sql` was authored as a parallel P0 fix alongside `0004_force_rls.sql`, rather than renaming `0004_raw_plaid_items_rls.sql` to `0005_raw_plaid_items_rls.sql`. This is unclean but functionally safe given the explicit `.sort()` call.

### Approvals hardening (`0020_approvals_hardening.sql`)

Adds `policy_version`, `revoked_at`, `signer_tenant_id`, and `status` columns to `approvals`. The `status` CHECK constraint (`'valid' | 'stale' | 'revoked'`) and a back-compat UPDATE (`SET signer_tenant_id = tenant_id WHERE signer_tenant_id IS NULL`) are present. This is a live data mutation at migration time. Safe because the table is in a known state (existing rows are same-tenant, status defaults `'valid'`).

---

## 4. Runtime Validation

### Invariants test suite

```
> @brain/invariants@0.1.0 test
> vitest run

 ✓ src/rls-coverage.test.ts (1 test) 25ms
 ✓ src/tenant-isolation.test.ts (16 tests | 13 skipped) 12ms
 ✓ src/invariants.test.ts (25 tests) 20ms
 ✓ src/schema-invariants.test.ts (5 tests) 9ms
 ✓ src/golden-path-questions.test.ts (10 tests) 20ms

 Test Files  5 passed (5)
      Tests  44 passed | 13 todo (57)
   Duration  3.85s
```

`rls-coverage.test.ts`. Checks every `tenant_id` table has ENABLE RLS: **PASS (1 test)**. Does NOT check `owner_id` tables (ledger) or FORCE. 13 cross-tenant HTTP probe tests are `todo` pending a live app + Postgres fixture.

### Migrate tool unit tests

```
> @brain/migrate@0.1.0 test
> vitest run

 ✓ src/runner.test.ts (6 tests) 19ms
 ✓ src/discover.test.ts (4 tests) 67ms

 Test Files  2 passed (2)
      Tests  10 passed (10)
```

The discover tests cover: stable global ordering, non-SQL file filtering, empty `services/` dir, missing `migrations/` dir per service. **No test covers two files with the same sequence prefix in the same service.**

### Integration tests

`tests/invariants/integration/db-invariants.integration.test.ts`. Skips entirely when `DATABASE_URL` is absent:

```typescript
const DB_URL = process.env.DATABASE_URL;
const suite = DB_URL !== undefined && DB_URL !== "" ? describe : describe.skip;
```

These 5 tests (audit append-only, RLS coverage against live pg_class, cross-tenant visibility probe, gate-bypass impossibility, confidence ceiling) are CI-only. Live verification of `relforcerowsecurity` is CI-only per BLOCKERS.md B-1.

### Static FORCE vs ENABLE scan

```
Has ENABLE but NOT FORCE (migrations):
  tenants

Has tenant_id but NOT ENABLE:
  (none)
```

All tables with `tenant_id` column have ENABLE RLS. The `tenants` table (which uses `id` as its isolation key, not `tenant_id`) has ENABLE but no FORCE migration. Relies on `infra/db-roles.sql` loop.

---

## 5. Functional Status

**Mostly Working**

P0 #2 and P0 #3 are resolved at code level: the `period_window` rename is present; 43/44 ENABLE'd tables have FORCE from migration files; the role model and DO $$ loop cover the remaining `tenants` table gap in production. The migration runner is solid (deterministic ordering, content-hash immutability, transactional application). Two test-quality gaps exist: `rls-coverage.test.ts` misses `owner_id`-keyed ledger tables, and the discover test suite has no duplicate-sequence test case. Live DB enforcement cannot be confirmed without DATABASE_URL.

---

## 6. Architectural Violations

**One cross-service migration concern (informational, not a violation):**

`services/execution/migrations/0019_force_rls.sql` applies `FORCE ROW LEVEL SECURITY` to `domain_events`. A table created by `services/audit/migrations/0006_domain_events.sql`. Conceptually, execution is modifying a table it doesn't own. Functionally this works because all services share the same public schema; there is no physical schema separation. The `audit/0007_force_rls.sql` did not include `domain_events`, making execution the de-facto owner of this FORCE migration. This is a minor service-boundary blur, not a blocking violation.

No business logic in migration files. No cross-tenant policy bypasses in migration SQL. No circular dependencies in migration ordering.

---

## 7. Missing Pieces

1. **`tenants` FORCE migration absent**: `services/api/migrations/` has no `0003_force_rls.sql` or equivalent. The gap is covered by `infra/db-roles.sql` in production, but a dev environment running migrations without the role script has an unforced `tenants` table. Fix: add `ALTER TABLE tenants FORCE ROW LEVEL SECURITY;` in a new `0003_force_rls.sql`.

2. **`rls-coverage.test.ts` blind to `owner_id` pattern**: Ledger tables use `owner_id` as their tenant isolation column. The static scanner regex looks for `\btenant_id\b`. No ledger table will ever trigger the "missing RLS" alert. A new ledger table could be added without ENABLE and the test would pass. Fix: extend the scanner to also check tables where the RLS policy uses `current_setting('app.tenant_id', true)`, regardless of column name.

3. **Duplicate `0004_*` sequence in `services/raw`**: `0004_raw_plaid_items_rls.sql` should be renamed to `0005_raw_plaid_items_rls.sql` (and `0005_raw_sources.sql` → `0006_raw_sources.sql`, `0006_force_rls_sources.sql` → `0007_force_rls_sources.sql`). This was not done at the time of the P0 fix. The functional result is correct, but the schema becomes harder to reason about and new developers will be confused.

4. **`discover.test.ts` gap**: No test asserts that two files with the same sequence number in the same service are handled deterministically. A test with `0004_aaa.sql` and `0004_zzz.sql` in the same service would document the behavior explicitly.

5. **Integration invariants blocked**: The 5 DB-level invariants in `db-invariants.integration.test.ts` (audit append-only, RLS cross-tenant probe, gate-bypass impossibility, confidence ceiling, audit pair) are CI-only. Live `pg_class.relforcerowsecurity` verification is unresolved.

---

## 8. Evidence

**P0 #2 confirmed:**
- `services/policy/migrations/0003_policy_spend_counters.sql:15`. `period_window TEXT NOT NULL`
- Lines 6–7. Comment documenting the rename from the reserved keyword `window`
- `UNIQUE` constraint (line 20) and index (lines 23–24) both use `period_window`

**P0 #3 confirmed (code):**
- 7 force_rls migration files: `audit/0007`, `execution/0019`, `ledger/0020`, `policy/0004`, `raw/0004`, `raw/0006`, `wiki/0006`
- `infra/db-roles.sql:44–57`. DO $$ loop applies FORCE to all `relrowsecurity` tables
- Node static scan: 43 tables have FORCE from migrations; 1 (`tenants`) has ENABLE only

**R-14 mitigated:**
- `tools/migrate/src/discover.ts:43`. `(await readdir(mDir)).filter(...).sort()`
- Node sort output: `['0004_force_rls.sql', '0004_raw_plaid_items_rls.sql', '0005_raw_sources.sql']`
- `tools/migrate/src/runner.ts`. `key = service/filename`, no sequence uniqueness constraint
- `services/raw/migrations/0004_force_rls.sql`. Applies FORCE (no ENABLE required first)
- `services/raw/migrations/0004_raw_plaid_items_rls.sql`. Applies ENABLE + policies

**Invariant tests green (DB-free):**
- `pnpm --filter @brain/invariants run test` → 5 files, 44 passed, 13 todo, duration 3.85s
- `pnpm -C tools/migrate run test` → 2 files, 10 passed

**`tenants` FORCE gap:**
- `services/api/migrations/`. Only 2 files; no force_rls migration present
- `infra/db-roles.sql:44–57`. Covers the gap in production
- Node scan result: "Has ENABLE but NOT FORCE: tenants"

**`rls-coverage.test.ts` scope:**
- `tests/invariants/src/rls-coverage.test.ts:33–43`. Regex tests `\btenant_id\b` in CREATE TABLE body only
- `services/ledger/migrations/0003_ledger_accounts.sql:9`. Column is `owner_id`, not `tenant_id`
- RLS policy on ledger: `USING (owner_id = current_setting('app.tenant_id', true))`. Correct predicate

---

## 9. Confidence Level

**Medium-High**

Code-level analysis is High confidence: all migration files were read, the static scan logic was replicated and verified, sort order was confirmed with Node.js. The runner's key-based tracking and the FORCE-before-ENABLE ordering are both unambiguous from source.

Dropped from High to Medium-High because:
- Live DB enforcement (`pg_class.relforcerowsecurity`) is unverified. CI-only
- The `infra/db-roles.sql` must be applied by an operator; there is no automated verification that it has been applied in any environment
- The `0020_approvals_hardening.sql` back-compat UPDATE runs a live data mutation; whether existing rows had the expected state at migration time cannot be verified from code alone

---

## 10. Production Readiness

**Score: 7/10**

**What works:**
- P0 #2 fixed: `period_window` is present and consistent throughout the policy migration
- P0 #3 largely fixed: 43/44 ENABLE'd tables have FORCE from migrations; the role model is well-designed
- Migration runner is solid: deterministic discovery, content-hash immutability, transactional apply, no key collision on R-14
- DB-free invariant tests pass: 44 tests across 5 files; the static RLS scan runs on every PR

**Blockers and risks:**
- **`tenants` FORCE gap (Medium risk)**: The most sensitive table in the system. A tenant row IS the tenant. Has ENABLE but no FORCE migration. In a dev environment without `db-roles.sql`, a table-owner connection bypasses RLS on `tenants`. Production is covered by the DO $$ loop, but developer environments are not, creating a potential source of "works in prod, not in dev" tenant-isolation bugs.
- **Live enforcement unverified**: `pg_class.relforcerowsecurity` has never been read against an actual migrated DB in this audit. The integration tests that would verify this are CI-only.
- **`rls-coverage.test.ts` blind spot**: All 13 ledger tables are unguarded by the static test. A new ledger table without ENABLE would pass the CI check. This is latent risk as the ledger schema grows.
- **R-14 cosmetically unresolved**: The duplicate `0004_` prefix is operationally safe but will confuse every future developer touching `services/raw/migrations/`. The `discover.test.ts` still lacks a regression test for this scenario.

---

## 11. Refactor Priority

**Medium**

None of the three issues is a P0. Production is protected by `db-roles.sql`, R-14 is functionally safe, and the `rls-coverage.test.ts` gap is latent. But all three are cheap to fix:

1. **Add `api/migrations/0003_force_rls.sql`**. Three-line migration, eliminates the `tenants` FORCE gap in dev environments.
2. **Extend `rls-coverage.test.ts`**. Add a second check for tables where RLS policies reference `current_setting('app.tenant_id', true)`, regardless of column name.
3. **Rename `raw/0004_raw_plaid_items_rls.sql` → `raw/0005_raw_plaid_items_rls.sql`** (and cascade renumber). Restores monotone sequence numbering in the raw service. A `brain_migrations` record for the old key was never inserted (this is a fresh fix), so a rename is safe as long as no DB has applied the current name.
4. **Add a discover test for duplicate sequence files**. Documents the existing behavior explicitly.
