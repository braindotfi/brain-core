-- Apply FORCE ROW LEVEL SECURITY to every tenant-scoped Wiki table.
--
-- Without this, Postgres silently bypasses the RLS policies when the
-- connection role is the table owner. See ledger/0020_force_rls.sql for
-- the full rationale.

BEGIN;

ALTER TABLE wiki_entities  FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_pages     FORCE ROW LEVEL SECURITY;
ALTER TABLE wiki_relations FORCE ROW LEVEL SECURITY;

COMMIT;
