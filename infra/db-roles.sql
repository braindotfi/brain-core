-- Brain Postgres role model (stage-8 deploy artifact).
--
-- §1 principle 2 requires tenant isolation enforced at the storage layer via
-- RLS. Two facts make a dedicated role model mandatory in production:
--
--   1. Postgres does NOT apply RLS to a table's OWNER unless the table is set
--      to FORCE ROW LEVEL SECURITY. If the app connects as the table owner (the
--      common single-URL dev setup), every `ENABLE ROW LEVEL SECURITY` policy
--      in our migrations is silently bypassed. So RLS is "armed" by the
--      migrations but only "enforced" once this role model is applied.
--
--   2. A few legitimate paths must read across tenants and therefore need a
--      role that bypasses RLS (rather than skipping RLS on the table):
--        - services/ledger normalize worker (cross-tenant processing log)
--        - services/api Plaid webhook tenant resolver (item_id → tenant, read
--          before a tenant scope exists)
--        - services/api SIWX PostgresAgentRegistry (onchain_address → agent)
--        - the audit emitter (writes across tenants)
--
-- Apply this once per database, as a superuser, at deploy time. Role passwords
-- come from Azure Key Vault (managed identity in production); the placeholders
-- below are substituted by the deploy pipeline. This file is NOT a
-- tools/migrate migration — role/grant management is an operator concern, not
-- an app migration (the migration role need not have CREATEROLE).

-- Role creation is idempotent: CREATE only when absent (inside a DO block,
-- which cannot interpolate psql :'vars'), then ALTER to (re)set the password
-- and attributes on every apply. This lets the deploy one-shot
-- (docker-compose.prod.yml `db-roles`) re-run safely across restarts and keeps
-- passwords in sync with the secret store.

-- 1. Request-path role: subject to RLS, never the table owner, no BYPASSRLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_app') THEN
    CREATE ROLE brain_app LOGIN;
  END IF;
END $$;
ALTER ROLE brain_app WITH LOGIN PASSWORD :'brain_app_password' NOBYPASSRLS;

-- 2. Privileged role: BYPASSRLS for the documented cross-tenant readers above.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_privileged') THEN
    CREATE ROLE brain_privileged LOGIN;
  END IF;
END $$;
ALTER ROLE brain_privileged WITH LOGIN PASSWORD :'brain_privileged_password' BYPASSRLS;

-- 3. Wiki-reader role (H-14): the Wiki projection reads Ledger truth (SELECT
--    anywhere) but must never write outside its own wiki_* tables. Subject to
--    RLS — the Wiki is a per-tenant projection, not a cross-tenant reader. The
--    api binds this role via BRAIN_WIKI_DB_URL so an accidental ledger_* write
--    on the Wiki path fails at the database, not just in review.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_wiki_reader') THEN
    CREATE ROLE brain_wiki_reader LOGIN;
  END IF;
END $$;
ALTER ROLE brain_wiki_reader WITH LOGIN PASSWORD :'brain_wiki_reader_password' NOBYPASSRLS;

-- brain_app + brain_privileged get full DML on the application schema; neither
-- owns the tables (the migration/owner role does), so RLS applies to brain_app.
GRANT USAGE ON SCHEMA public TO brain_app, brain_privileged, brain_wiki_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO brain_app, brain_privileged;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brain_app, brain_privileged;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brain_app, brain_privileged;

-- brain_wiki_reader: SELECT on everything (read Ledger truth), but write only
-- the wiki_* projection tables. New tables default to SELECT-only for it.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO brain_wiki_reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brain_wiki_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO brain_wiki_reader;
DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'wiki\_%'
  LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON %s TO brain_wiki_reader', t);
  END LOOP;
END
$$;

-- §1.4 audit append-only: the audit log must be IMMUTABLE to every runtime role.
-- The blanket DML grant above (and the default privileges) hand brain_app +
-- brain_privileged UPDATE/DELETE on every table, and `REVOKE ... FROM PUBLIC` in
-- the audit migration does NOT strip an explicit role grant. Revoke the mutation
-- rights on audit_events here so neither the request role (within its tenant) nor
-- the privileged role (across all tenants) can rewrite or erase audit history.
-- The append-only guarantee the on-chain anchor and proofs rely on is otherwise
-- unenforced at the DB level. Only the migration/owner role retains the ability
-- to administratively repair audit data, through a separately controlled, audited
-- procedure. (Codex 307161b P1 #1.)
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events
  FROM brain_app, brain_privileged, brain_wiki_reader;

-- Defence in depth: FORCE RLS on every tenant-scoped table so even a connection
-- that happens to be the table owner is still subject to the tenant_isolation
-- policy. Applies to every table that has RLS enabled (set by the migrations).
DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Deploy wiring (env): request-path services connect with brain_app via
-- DATABASE_URL; the cross-tenant readers listed above connect with
-- brain_privileged via DATABASE_PRIVILEGED_URL; the Wiki projection connects
-- with brain_wiki_reader via BRAIN_WIKI_DB_URL. In NODE_ENV=production the api
-- fails to boot if DATABASE_PRIVILEGED_URL or BRAIN_WIKI_DB_URL is unset
-- (services/api/src/composition/db-isolation.ts). Migrations run as the
-- owner/superuser role (its own DATABASE_URL), not as any of these three.
