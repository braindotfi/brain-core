-- H-14 Postgres role isolation for the Wiki layer.
--
-- "Wiki is read-only against the Ledger" is a §8.4 invariant + a CI guard
-- (check-wiki-no-ledger-write). This role makes it PHYSICAL: a separate
-- brain_wiki_reader role can SELECT every table (Wiki derives pages from Ledger
-- reads) but may only INSERT/UPDATE/DELETE the wiki_* tables it owns. An
-- accidental write to ledger_* from a Wiki code path then raises a Postgres
-- permission error rather than silently corrupting financial truth.
--
-- Note: the spec listed wiki_pages/wiki_snapshots/wiki_annotations; the actual
-- Wiki-owned tables in this codebase are wiki_entities, wiki_pages, wiki_relations
-- (no snapshots/annotations tables exist), so the write grant targets those.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_wiki_reader') THEN
    CREATE ROLE brain_wiki_reader;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO brain_wiki_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO brain_wiki_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO brain_wiki_reader;

-- Write access ONLY to the Wiki-owned tables.
GRANT INSERT, UPDATE, DELETE ON wiki_entities, wiki_pages, wiki_relations TO brain_wiki_reader;

COMMIT;
