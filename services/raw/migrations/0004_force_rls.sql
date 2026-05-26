-- Apply FORCE ROW LEVEL SECURITY to every tenant-scoped Raw table.
--
-- Without this, Postgres silently bypasses the RLS policies when the
-- connection role is the table owner. See ledger/0020_force_rls.sql for
-- the full rationale.

BEGIN;

ALTER TABLE raw_artifacts   FORCE ROW LEVEL SECURITY;
ALTER TABLE raw_parsed      FORCE ROW LEVEL SECURITY;
ALTER TABLE raw_plaid_items FORCE ROW LEVEL SECURITY;

COMMIT;
