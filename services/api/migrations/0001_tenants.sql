-- P0.1: tenants table — per-tenant gate-enforcement flags.
--
-- Brain previously modeled tenant context purely as the `app.tenant_id` session
-- GUC plus `owner_id` columns; there was no tenant registry table. P0.1 adds one
-- so production tenants can opt into MANDATORY gate enforcement — starting with
-- behavior-hash pinning (§6 gate check 1.5). "Skipped when unverifiable" is a
-- back door; opting a tenant in makes a missing runtime OR registered hash a
-- hard fail.
--
-- Back-compat: `require_behavior_hash` defaults FALSE. Every existing tenant has
-- NO row here, and `resolveTenantFlags` returns FALSE when no row exists, so the
-- canonical-13 happy path is unchanged until a tenant is explicitly opted in.
--
-- §1 principle 2: RLS on every tenant-scoped table. A tenant row IS the tenant,
-- so the isolation predicate is `id = app.tenant_id`. Migrations only ARM RLS
-- (ENABLE); it is enforced under the infra/db-roles.sql role model (FORCE RLS +
-- non-owner brain_app role).

BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  require_behavior_hash BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenants IS
  'Per-tenant gate-enforcement flags. A row IS the tenant; absence ⇒ all flags default off.';
COMMENT ON COLUMN tenants.require_behavior_hash IS
  'When true, §6 gate check 1.5 (agent behavior pinned) is mandatory — missing runtime/registered hash fails closed.';

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON tenants
  FOR INSERT
  WITH CHECK (id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON tenants
  FOR UPDATE
  USING (id = current_setting('app.tenant_id', true))
  WITH CHECK (id = current_setting('app.tenant_id', true));

COMMIT;
