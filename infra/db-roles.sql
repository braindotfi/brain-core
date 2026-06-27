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

-- 4. Least-privilege cross-tenant roles (replace the single broad brain_privileged
--    for the API runtime). Each is BYPASSRLS (its job is genuinely cross-tenant)
--    but receives only the table grants in the matrix below, so a confused-deputy
--    bug or compromise in one privileged path cannot reach another layer's tables.
--    brain_privileged remains ONLY for the deploy-time seed one-shot
--    (docker-compose `seed`), never the running API runtime (the broadest surface).
--      brain_raw_worker          sync + interpret workers     (raw_* tables)
--      brain_canonical_projector canonical projection worker  (canonical_* + read raw_parsed)
--      brain_ledger_projector    ledger projection workers     (ledger projections + read canonical_*)
--      brain_execution_worker    outbox drain worker           (execution_outbox claim/mark only)
--      brain_audit_verifier      audit consistency verifier    (audit_events read + verifier state)
--      brain_audit_publisher     anchor tenant enumeration     (audit_events read only)
--      brain_resolver            webhook/SIWX/login resolvers  (cross-tenant SELECT only)
--      brain_tenant_deletion     GDPR erasure svc + blob-purge (broad DELETE, route-gated)
--      brain_surface_gateway     approval webhooks only (surface_* + approvals)
DO $$
DECLARE
  rolename text;
BEGIN
  FOREACH rolename IN ARRAY ARRAY[
    'brain_raw_worker', 'brain_canonical_projector', 'brain_ledger_projector',
    'brain_execution_worker', 'brain_audit_verifier', 'brain_audit_publisher',
    'brain_resolver', 'brain_tenant_deletion', 'brain_surface_gateway'
  ] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = rolename) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', rolename);
    END IF;
  END LOOP;
END $$;
ALTER ROLE brain_raw_worker          WITH LOGIN PASSWORD :'brain_raw_worker_password' BYPASSRLS;
ALTER ROLE brain_canonical_projector WITH LOGIN PASSWORD :'brain_canonical_projector_password' BYPASSRLS;
ALTER ROLE brain_ledger_projector    WITH LOGIN PASSWORD :'brain_ledger_projector_password' BYPASSRLS;
ALTER ROLE brain_execution_worker    WITH LOGIN PASSWORD :'brain_execution_worker_password' BYPASSRLS;
ALTER ROLE brain_audit_verifier      WITH LOGIN PASSWORD :'brain_audit_verifier_password' BYPASSRLS;
ALTER ROLE brain_audit_publisher     WITH LOGIN PASSWORD :'brain_audit_publisher_password' BYPASSRLS;
ALTER ROLE brain_resolver            WITH LOGIN PASSWORD :'brain_resolver_password' BYPASSRLS;
ALTER ROLE brain_tenant_deletion     WITH LOGIN PASSWORD :'brain_tenant_deletion_password' BYPASSRLS;
ALTER ROLE brain_surface_gateway     WITH LOGIN PASSWORD :'brain_surface_gateway_password' NOBYPASSRLS;

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

-- ---------------------------------------------------------------------------
-- Least-privilege grant matrix for the §4 roles. Each role starts with NO
-- table privileges (it is absent from the blanket grant above) and receives
-- only what its consumer touches (footprints verified against the worker
-- source). Prefix-pattern loops mirror the wiki_reader pattern so re-applying
-- db-roles.sql after a new migration keeps a role's layer current.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO
  brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
  brain_execution_worker, brain_audit_verifier, brain_audit_publisher,
  brain_resolver, brain_tenant_deletion, brain_surface_gateway;
-- Writer roles may hit serial-backed tables; read-only roles (publisher,
-- resolver) get no sequence access.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO
  brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
  brain_execution_worker, brain_audit_verifier, brain_tenant_deletion,
  brain_surface_gateway;

-- brain_raw_worker: full DML on the raw layer (sync + interpret workers).
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'raw\_%'
  LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO brain_raw_worker', t); END LOOP;
END $$;

-- brain_canonical_projector: full DML on canonical_*, SELECT on raw_parsed (input).
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'canonical\_%'
  LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO brain_canonical_projector', t); END LOOP;
END $$;
GRANT SELECT ON raw_parsed TO brain_canonical_projector;

-- brain_ledger_projector: SELECT on canonical_* (input); DML ONLY on the three
-- ledger projection targets (NOT the money-path ledger_* tables).
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'canonical\_%'
  LOOP EXECUTE format('GRANT SELECT ON %s TO brain_ledger_projector', t); END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_gl_accounts, ledger_obligations, ledger_counterparties
  TO brain_ledger_projector;
-- The ledger_counterparties writer trigger (ledger/0027) is plain plpgsql and
-- runs as the invoking role, INSERTing into ledger_counterparty_payment_instructions.
-- The AP/AR canonical projector (Phase 5) writes counterparties as
-- brain_ledger_projector, so it needs INSERT on the trigger target table too.
GRANT INSERT ON ledger_counterparty_payment_instructions TO brain_ledger_projector;

-- brain_execution_worker: cross-tenant claim/reclaim/mark on the outbox only.
-- The per-row settle re-enters tenant scope on brain_app, so this role needs no
-- money-path (ledger_*) grants at all.
GRANT SELECT, INSERT, UPDATE ON execution_outbox TO brain_execution_worker;

-- brain_audit_verifier: read audit_events; advance the verifier cursor; append
-- findings (no UPDATE/DELETE on findings — a detected break is un-erasable).
GRANT SELECT ON audit_events TO brain_audit_verifier;
GRANT SELECT, INSERT, UPDATE ON audit_verifier_checkpoint TO brain_audit_verifier;
GRANT SELECT, INSERT ON audit_integrity_findings TO brain_audit_verifier;

-- brain_audit_publisher: cross-tenant audit_events enumeration only (the
-- per-tenant publish runs on brain_app under RLS).
GRANT SELECT ON audit_events TO brain_audit_publisher;

-- brain_resolver: cross-tenant SELECT only, for the webhook/SIWX/login resolvers.
GRANT SELECT ON raw_sync_partitions, wallet_identities, users TO brain_resolver;

-- brain_surface_gateway: tenant-scoped webhook decisions and delivery state.
-- No ledger_* or execution_outbox grants. The handoff stops at approvals.
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'surface\_%'
  LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO brain_surface_gateway', t); END LOOP;
END $$;
GRANT SELECT ON users, policies TO brain_surface_gateway;
GRANT SELECT, INSERT, UPDATE ON approvals TO brain_surface_gateway;

-- brain_tenant_deletion: GDPR Article 17 erasure (route-gated) + blob-purge
-- worker. Broad DELETE across tenant-scoped (RLS) tables — that IS the erasure
-- concern — plus the tenant registry and the purge bookkeeping. audit_events /
-- audit_anchors are preserved (the append-only REVOKE below strips DELETE).
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP EXECUTE format('GRANT SELECT, DELETE ON %s TO brain_tenant_deletion', t); END LOOP;
END $$;
GRANT SELECT, DELETE ON tenants TO brain_tenant_deletion;
GRANT SELECT, UPDATE ON raw_artifacts TO brain_tenant_deletion;
GRANT SELECT, INSERT, UPDATE ON tenant_blob_purge_jobs, tenant_blob_purge_audit_outbox
  TO brain_tenant_deletion;

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
-- Includes the §4 roles: brain_tenant_deletion's broad RLS-table DELETE would
-- otherwise cover audit_events (it is RLS-scoped), which must stay preserved;
-- the audit verifier/publisher keep their SELECT (only mutation is stripped).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events
  FROM brain_app, brain_privileged, brain_wiki_reader,
       brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
       brain_execution_worker, brain_audit_verifier, brain_audit_publisher,
       brain_resolver, brain_tenant_deletion, brain_surface_gateway;

-- Audit-verifier FORENSIC state (audit_verifier_checkpoint, audit_integrity_findings):
-- global, RLS-exempt tables that PROVE tamper detection. Only the privileged verifier
-- pool (brain_privileged) ever touches them. Under the blanket DML grant above the
-- request role (brain_app) could otherwise read cross-tenant findings + hashes, forge
-- findings, delete or resolve real ones, or reset the verification cursor; and the wiki
-- reader could read them. Strip both non-verifier roles entirely, and make findings
-- APPEND-ONLY for every runtime role (no role may erase a detected break — the same
-- guarantee as audit_events). brain_privileged retains exactly the verifier's needs:
-- checkpoint SELECT/INSERT/UPDATE (the cursor advances) and findings SELECT/INSERT.
-- A controlled resolution path (a later change) will grant finding UPDATE to a
-- dedicated recovery role, not to the broad runtime roles. (Codex 9389568 P1.)
-- brain_audit_verifier is the only §4 role that touches the forensic tables; it
-- gets the same confinement brain_privileged had (cursor S/I/U + findings S/I,
-- but no erase). Every other §4 role is stripped entirely (defense in depth —
-- the forensic tables are RLS-exempt so they were never in any grant loop).
REVOKE ALL ON audit_verifier_checkpoint, audit_integrity_findings
  FROM brain_app, brain_wiki_reader,
       brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
       brain_execution_worker, brain_audit_publisher, brain_resolver,
       brain_tenant_deletion, brain_surface_gateway;
REVOKE DELETE, TRUNCATE ON audit_verifier_checkpoint
  FROM brain_privileged, brain_audit_verifier;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_integrity_findings
  FROM brain_privileged, brain_audit_verifier;

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
-- DATABASE_URL; the Wiki projection connects with brain_wiki_reader via
-- BRAIN_WIKI_DB_URL; each §4 cross-tenant role connects via its own URL:
--   brain_raw_worker          BRAIN_RAW_WORKER_DB_URL
--   brain_canonical_projector BRAIN_CANONICAL_PROJECTOR_DB_URL
--   brain_ledger_projector    BRAIN_LEDGER_PROJECTOR_DB_URL
--   brain_execution_worker    BRAIN_EXECUTION_WORKER_DB_URL
--   brain_audit_verifier      BRAIN_AUDIT_VERIFIER_DB_URL
--   brain_audit_publisher     BRAIN_AUDIT_PUBLISHER_DB_URL
--   brain_resolver            BRAIN_RESOLVER_DB_URL
--   brain_tenant_deletion     BRAIN_TENANT_DELETION_DB_URL
--   brain_surface_gateway     BRAIN_SURFACE_GATEWAY_DB_URL
-- In NODE_ENV=production the api fails to boot if BRAIN_WIKI_DB_URL or any of
-- the eight §4 URLs is unset (services/api/src/composition/db-isolation.ts);
-- in dev/test each falls back to DATABASE_URL with a warning. The API runtime
-- no longer uses brain_privileged; it survives ONLY for the deploy-time seed
-- one-shot (docker-compose `seed`). Migrations run as the owner/superuser role.
