-- Apply FORCE ROW LEVEL SECURITY to every tenant-scoped Policy table.
--
-- Without this, Postgres silently bypasses the RLS policies when the
-- connection role is the table owner. See ledger/0020_force_rls.sql for
-- the full rationale.

BEGIN;

ALTER TABLE policies               FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions       FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_spend_counters  FORCE ROW LEVEL SECURITY;

COMMIT;
