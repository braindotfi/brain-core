-- Apply FORCE ROW LEVEL SECURITY to every tenant-scoped Audit table.
--
-- Without this, Postgres silently bypasses the RLS policies when the
-- connection role is the table owner. See ledger/0020_force_rls.sql for
-- the full rationale.

BEGIN;

ALTER TABLE audit_anchors       FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_dead_letters FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints   FORCE ROW LEVEL SECURITY;

COMMIT;
