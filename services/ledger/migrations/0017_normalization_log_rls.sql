-- Enable row-level security on normalization_log.
--
-- Migration 0013 deliberately skipped RLS, reasoning that the normalizeWorker
-- scans this table across all tenants. But §1 requires RLS on every
-- tenant-scoped table, and the correct pattern (see the withTenantScope doc in
-- shared/src/db/tenant-scoped.ts) is RLS on the table PLUS a BYPASSRLS role for
-- the legitimate cross-tenant reader — not skipping RLS. The normalize worker
-- already documents it must run under BYPASSRLS in production
-- (services/ledger/src/workers/normalizeWorker.ts). RLS here is the
-- defense-in-depth backstop so ordinary request-path connections cannot read
-- the cross-tenant processing log.

BEGIN;

ALTER TABLE normalization_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON normalization_log
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON normalization_log
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
