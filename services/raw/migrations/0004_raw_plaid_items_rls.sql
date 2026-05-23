-- Enable row-level security on raw_plaid_items. Migration 0003 created it
-- without RLS, but §1 requires RLS on every tenant-scoped table.
--
-- raw_plaid_items maps Plaid item_id → tenant and is read during webhook tenant
-- resolution BEFORE any tenant scope exists (no bearer JWT). That legitimate
-- cross-tenant read must therefore run under a BYPASSRLS role in production —
-- the same requirement the normalize worker already documents. RLS here is
-- defense-in-depth: ordinary request-path (non-privileged) connections can no
-- longer read the item→tenant map across tenants.

BEGIN;

ALTER TABLE raw_plaid_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON raw_plaid_items
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON raw_plaid_items
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON raw_plaid_items
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
