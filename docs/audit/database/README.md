# Audit Area: Database

**Scope:** Migration correctness, RLS enforcement, tenant isolation, schema ownership, and cross-service DB access patterns.

**Reports planned:**

- `migrations-and-rls.md`. Re-verify the two P0 remediations from the prior audit with live evidence (requires `DATABASE_URL`; CI is the canonical verifier per `BLOCKERS.md` B-1):
  - P0 #2 (`window` keyword): `services/policy/migrations/0003_policy_spend_counters.sql`. Confirm `window` → `period_window` rename.
  - P0 #3 (RLS): All six force-RLS migrations (`0007_force_rls.sql`, `0019_force_rls.sql`, `0020_force_rls.sql`, etc.) plus `infra/db-roles.sql`. Do `pg_class.relforcerowsecurity = true` on all tenant-scoped tables after migration?
  - New: `services/api/migrations/` tenant table (RLS via `id = app.tenant_id`). Correct isolation predicate?
  - `tests/invariants/integration/db-invariants.integration.test.ts` (CI-only, new P0.2). What does it assert?

**Migration count by service** (as of 2026-05-26):

- `services/api/migrations/`: 2 (tenants, tenants_default_ap_account)
- `services/raw/migrations/`: 7. **two files share sequence prefix `0004_`** (`0004_force_rls.sql` + `0004_raw_plaid_items_rls.sql`). Migration ordering conflict risk.
- `services/ledger/migrations/`: 20
- `services/wiki/migrations/`: 6
- `services/policy/migrations/`: 4
- `services/execution/migrations/`: 20 (0001_proposals → 0020_approvals_hardening)
- `services/audit/migrations/`: 7
- **Total: 66 migration files**

**Relevant files:** `services/*/migrations/`, `infra/db-roles.sql`, `tools/migrate/`, `tests/invariants/integration/db-invariants.integration.test.ts`, `tests/invariants/src/rls-coverage.test.ts`.
