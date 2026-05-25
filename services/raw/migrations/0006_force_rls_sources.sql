-- Apply FORCE ROW LEVEL SECURITY to raw_sources.
--
-- Without this, Postgres silently bypasses the RLS policies when the
-- connection role is the table owner. Mirrors 0004_force_rls.sql.

BEGIN;

ALTER TABLE raw_sources FORCE ROW LEVEL SECURITY;

COMMIT;
