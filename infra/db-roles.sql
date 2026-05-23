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

-- 1. Request-path role: subject to RLS, never the table owner, no BYPASSRLS.
CREATE ROLE brain_app LOGIN PASSWORD :'brain_app_password' NOBYPASSRLS;

-- 2. Privileged role: BYPASSRLS for the documented cross-tenant readers above.
CREATE ROLE brain_privileged LOGIN PASSWORD :'brain_privileged_password' BYPASSRLS;

-- Both roles get DML on the application schema; neither owns the tables (the
-- migration/owner role does), so RLS applies to brain_app.
GRANT USAGE ON SCHEMA public TO brain_app, brain_privileged;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO brain_app, brain_privileged;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brain_app, brain_privileged;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brain_app, brain_privileged;

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
-- brain_privileged via PRIVILEGED_DATABASE_URL. Until that split is wired,
-- those readers rely on running as a BYPASSRLS/owner role.
