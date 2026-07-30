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

-- 4. MCP raw evidence reader. Tenant-scoped and read-only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_mcp_reader') THEN
    CREATE ROLE brain_mcp_reader LOGIN;
  END IF;
END $$;
ALTER ROLE brain_mcp_reader WITH LOGIN PASSWORD :'brain_mcp_reader_password' NOBYPASSRLS;

-- 5. Least-privilege cross-tenant roles (replace the single broad brain_privileged
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
--      brain_surface_audit_writer audit_events append only for surface gateway
--      brain_auth                OAuth authorization server core (oauth_*, tenant-scoped)
--      brain_auth_audit_writer   audit_events append only for the authorization server
DO $$
DECLARE
  rolename text;
BEGIN
  FOREACH rolename IN ARRAY ARRAY[
    'brain_raw_worker', 'brain_canonical_projector', 'brain_ledger_projector',
    'brain_execution_worker', 'brain_audit_verifier', 'brain_audit_publisher',
    'brain_resolver', 'brain_tenant_deletion', 'brain_surface_gateway',
    'brain_surface_audit_writer', 'brain_auth', 'brain_auth_audit_writer'
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
ALTER ROLE brain_surface_audit_writer WITH LOGIN PASSWORD :'brain_surface_audit_writer_password' NOBYPASSRLS;
ALTER ROLE brain_auth                WITH LOGIN PASSWORD :'brain_auth_password' NOBYPASSRLS;
ALTER ROLE brain_auth_audit_writer   WITH LOGIN PASSWORD :'brain_auth_audit_writer_password' NOBYPASSRLS;

-- brain_app gets request-path DML on the application schema; it does not own the
-- tables, so RLS applies to it. brain_privileged is intentionally excluded from
-- the blanket runtime grant and receives only the seed and verifier footprint
-- below.
GRANT USAGE ON SCHEMA public TO brain_app, brain_privileged, brain_wiki_reader,
  brain_mcp_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO brain_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brain_app, brain_privileged;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brain_app;

-- brain_privileged: deploy-time seed one-shot and audit verifier fallback only.
-- It is BYPASSRLS but not a live API runtime role. Keep the table footprint
-- explicit so a seed compromise cannot append audit_events or mutate unrelated
-- live-money tables.
GRANT SELECT, INSERT, UPDATE ON tenants, policies, members TO brain_privileged;
GRANT SELECT, INSERT, UPDATE, DELETE ON agents TO brain_privileged;
GRANT SELECT, INSERT, UPDATE ON ledger_counterparty_payment_instructions
  TO brain_privileged;
GRANT SELECT, INSERT ON ledger_documents, ledger_invoices, ledger_obligations,
  ledger_payment_intents TO brain_privileged;
GRANT SELECT, INSERT, UPDATE ON audit_verifier_checkpoint TO brain_privileged;
GRANT SELECT, INSERT ON audit_integrity_findings TO brain_privileged;

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

-- brain_mcp_reader: MCP raw evidence read path only. Column grants deliberately
-- omit blob_uri, and this role receives no write grants or grants on Policy or
-- Audit tables in PR 1 of RFC 0006.
GRANT SELECT (
  id, tenant_id, sha256, source_type, source_ref, mime_type, bytes,
  ingested_at, tombstoned_at, ingested_by, source_schema, object_type,
  external_id, operation, effective_at, observed_at, original_source,
  intermediaries, source_id, source_version, idempotency_key
) ON raw_artifacts TO brain_mcp_reader;
GRANT SELECT (
  id, raw_artifact_id, tenant_id, parser, parser_version, extracted,
  confidence, extracted_at
) ON raw_parsed TO brain_mcp_reader;

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
  brain_resolver, brain_tenant_deletion, brain_surface_gateway,
  brain_surface_audit_writer, brain_auth, brain_auth_audit_writer;
-- Writer roles may hit serial-backed tables; read-only roles (publisher,
-- resolver) get no sequence access.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO
  brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
  brain_execution_worker, brain_audit_verifier, brain_tenant_deletion,
  brain_surface_gateway;

-- brain_raw_worker: raw layer writes. It reads canonical_projection_log
-- (hasTerminalZeroProjectionLog) but no longer deletes from it: repairing a
-- corrected upload parsed row now bumps raw_parsed.extracted_at, which the
-- canonical projector's version-gated pending predicate treats as a fresh
-- payload version on its own (services/canonical migration 0005). DELETE was
-- previously required so a repair could force replay by hand, which
-- re-introduced the same over-broad grant class PR #330 revoked below.
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'raw\_%'
  LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO brain_raw_worker', t); END LOOP;
END $$;
GRANT SELECT ON extraction_jobs TO brain_raw_worker;
GRANT SELECT ON canonical_projection_log TO brain_raw_worker;

-- brain_canonical_projector: canonical writes, SELECT on raw_parsed (input).
-- Only canonical_journal_line is deleted by the projector, as a line-replace
-- step during journal-entry upsert.
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'canonical\_%'
  LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO brain_canonical_projector', t); END LOOP;
END $$;
GRANT DELETE ON canonical_journal_line TO brain_canonical_projector;
GRANT SELECT ON raw_parsed TO brain_canonical_projector;

-- brain_ledger_projector: SELECT on canonical_* (input); DML ONLY on the
-- rebuildable ledger projection targets (NOT the money-path ledger_* tables).
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'canonical\_%'
  LOOP EXECUTE format('GRANT SELECT ON %s TO brain_ledger_projector', t); END LOOP;
END $$;
-- AP/AR projection may repair stale canonical counterparty links before
-- mirroring obligations. Keep that write as narrow as the repair path.
GRANT UPDATE (canonical_counterparty_id, updated_at) ON canonical_obligation
  TO brain_ledger_projector;
GRANT SELECT, INSERT, UPDATE ON ledger_gl_accounts, ledger_obligations, ledger_counterparties,
  ledger_accounts, ledger_transactions, ledger_invoices
  TO brain_ledger_projector;
-- The Collections, Reconciliation, Cash Forecast, Vendor Risk, Fraud Anomaly,
-- and Compliance scanners share the ledger worker pool for cross-tenant enumeration only.
-- They need ledger and cooldown reads, then
-- re-enter tenant-scoped brain_app for cooldown writes and AgentRunService proposals.
GRANT SELECT ON ledger_accounts, ledger_balances, ledger_invoices, ledger_transactions,
  ledger_payment_intents, approvals, policy_decisions, audit_events
  TO brain_ledger_projector;
GRANT SELECT ON ledger_counterparty_payment_instructions TO brain_ledger_projector;
GRANT SELECT ON agent_trigger_cooldowns TO brain_ledger_projector;
-- The ledger_counterparties writer trigger (ledger/0027) is plain plpgsql and
-- runs as the invoking role, INSERTing into ledger_counterparty_payment_instructions.
-- The AP/AR canonical projector (Phase 5) writes counterparties as
-- brain_ledger_projector, so it needs INSERT on the trigger target table too.
GRANT INSERT ON ledger_counterparty_payment_instructions TO brain_ledger_projector;

-- brain_execution_worker: cross-tenant claim/reclaim/mark on the outbox only.
-- The per-row settle re-enters tenant scope on brain_app, so this role needs no
-- money-path (ledger_*) grants at all.
GRANT SELECT, INSERT, UPDATE ON execution_outbox TO brain_execution_worker;

-- brain_audit_verifier: read audit_events; scan and heal audit_anchors;
-- advance the verifier cursor; append findings. No UPDATE/DELETE on findings,
-- so a detected break is un-erasable.
GRANT SELECT ON audit_events TO brain_audit_verifier;
GRANT SELECT, UPDATE ON audit_anchors TO brain_audit_verifier;
GRANT SELECT, INSERT, UPDATE ON audit_verifier_checkpoint TO brain_audit_verifier;
GRANT SELECT, INSERT ON audit_integrity_findings TO brain_audit_verifier;

-- brain_audit_publisher: cross-tenant audit_events enumeration only (the
-- per-tenant publish runs on brain_app under RLS).
GRANT SELECT ON audit_events TO brain_audit_publisher;
GRANT SELECT ON webhook_endpoints, webhook_dead_letters, webhook_delivery_receipts
  TO brain_audit_publisher;

-- brain_resolver: cross-tenant SELECT only, for the webhook/SIWX/login/session resolvers.
-- Extended for the OAuth core (Phase 2a): agents (pre-tenant OAuth agent
-- lookups) plus the oauth_* pre-tenant lookups (code_hash -> row, token_hash
-- -> row). oauth_consent_grants is intentionally excluded: it is reached only
-- through an already-tenant-scoped code or refresh token, never a pre-tenant
-- lookup.
GRANT SELECT ON raw_sync_partitions, wallet_identities, users, members, member_identity_links,
  member_invites, session_refresh_tokens, api_keys, agents, oauth_clients,
  oauth_authorization_codes, oauth_refresh_tokens TO brain_resolver;

-- brain_surface_gateway: tenant-scoped webhook decisions and delivery state.
-- No ledger_* or execution_outbox grants. The handoff stops at approvals.
DO $$
DECLARE t regclass;
BEGIN
  FOR t IN SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'surface\_%'
  LOOP EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO brain_surface_gateway', t); END LOOP;
END $$;
GRANT SELECT ON users, members, member_identity_links, policies TO brain_surface_gateway;
GRANT SELECT, INSERT, UPDATE ON approvals TO brain_surface_gateway;

-- brain_surface_audit_writer: append-only audit events for the surface gateway
-- audit pool. It intentionally has no grants on surface, ledger, approval, or
-- outbox tables. Append-only means no mutation of EXISTING rows (the REVOKE
-- UPDATE, DELETE, TRUNCATE below still applies), not blind writes:
-- PostgresAuditEmitter.emit (shared/src/audit/emitter.ts) reads the
-- hash-chain predecessor (`SELECT event_hash FROM audit_events ... LIMIT 1`)
-- before every insert, so SELECT is structurally required or every emit
-- raises 42501 permission denied. Verified live: INSERT-only broke every
-- emit from this role. Do not "harden" this back to INSERT-only.
GRANT SELECT, INSERT ON audit_events TO brain_surface_audit_writer;

-- brain_auth: the OAuth authorization server core (Phase 2a, OAUTH-AS-PLAN.md
-- section 4 / AUTH-PATHS-PLAN.md section 6). NOBYPASSRLS -- unlike the other
-- section 4 roles, the AS is tenant-scoped per request like brain_app, not a
-- cross-tenant reader, so RLS applies to it. No DELETE anywhere: codes and
-- tokens are marked consumed or revoked, never deleted. The column-list GRANT
-- UPDATE on users matters: a compromised AS cannot change email, tenant_id,
-- or role.
GRANT SELECT, INSERT, UPDATE ON oauth_clients, oauth_authorization_codes,
  oauth_consent_grants, oauth_refresh_tokens TO brain_auth;
GRANT SELECT, INSERT, UPDATE ON email_verifications TO brain_auth;
-- No grant on wallet_identities: Path 2 (wallet + SIWE login at the AS) is
-- design-only, not built in v1 (AUTH-PATHS-PLAN.md section 3). No Phase 2a
-- code writes wallet_identities, so the grant bought nothing today and was a
-- session-minting primitive: siwx.ts resolves a linked wallet straight to an
-- owner JWT, so brain_auth alone could insert a row binding an attacker
-- address to any tenant owner and mint an owner JWT via POST /v1/auth/siwx.
-- RLS does not contain this because brain_auth sets its own app.tenant_id.
-- Add SELECT, INSERT back here when Path 2 ships.
GRANT UPDATE (password_hash, email_verified_at, status) ON users TO brain_auth;
GRANT SELECT ON users, members, member_identity_links, tenants, agents TO brain_auth;

COMMENT ON ROLE brain_auth IS
  'OAuth authorization server core (auth.brain.fi). Containment: brain_auth cannot INSERT or UPDATE members, cannot touch session_refresh_tokens or member_invites, cannot INSERT tenants or users, cannot UPDATE agents, and holds nothing on any ledger_* table or execution_outbox. The AS cannot mint a Brain session directly (no session table, no JWT signing key), but its column-list GRANT UPDATE (password_hash, email_verified_at, status) ON users is a credential-write primitive equivalent to one: setting a known scrypt hash on any owner and then calling POST /v1/auth/login reaches the same outcome as a minted session. AS compromise must therefore be modelled as tenant-wide account takeover, not merely as an OAuth-scoped foothold.';

-- brain_auth_audit_writer: append-only audit events for the authorization
-- server's audit pool, mirroring brain_surface_audit_writer. Required, not
-- optional: brain_privileged deliberately cannot insert audit_events, so
-- every writer needs its own narrow role. SELECT is required alongside
-- INSERT for the same reason as brain_surface_audit_writer above: the
-- hash-chain predecessor read in PostgresAuditEmitter.emit 42501s without it,
-- turning every /login, /set-password, and /forgot-password audit emit into
-- a 500 (finding 1). Append-only is enforced by the REVOKE UPDATE, DELETE,
-- TRUNCATE below, not by withholding SELECT.
GRANT SELECT, INSERT ON audit_events TO brain_auth_audit_writer;

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
GRANT SELECT, UPDATE ON tenant_export_jobs TO brain_tenant_deletion;

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
       brain_mcp_reader,
       brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
       brain_execution_worker, brain_audit_verifier, brain_audit_publisher,
       brain_resolver, brain_tenant_deletion, brain_surface_gateway,
       brain_surface_audit_writer, brain_auth, brain_auth_audit_writer;
REVOKE INSERT ON audit_events
  FROM brain_privileged, brain_wiki_reader,
       brain_mcp_reader,
       brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
       brain_execution_worker, brain_audit_verifier, brain_audit_publisher,
       brain_resolver, brain_tenant_deletion, brain_surface_gateway, brain_auth;

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
       brain_mcp_reader,
       brain_raw_worker, brain_canonical_projector, brain_ledger_projector,
       brain_execution_worker, brain_audit_publisher, brain_resolver,
       brain_tenant_deletion, brain_surface_gateway, brain_surface_audit_writer,
       brain_auth, brain_auth_audit_writer;
REVOKE DELETE, TRUNCATE ON audit_verifier_checkpoint
  FROM brain_privileged, brain_audit_verifier;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_integrity_findings
  FROM brain_privileged, brain_audit_verifier;

-- Layer-truth append-only: raw_artifacts, canonical_journal_entry, and
-- ledger_obligations are append-only to their projection workers. The prefix
-- grant loops above hand SELECT, INSERT, UPDATE by table name. An earlier grant
-- footprint (4883296) also granted DELETE, and tightening the loop (1f74d74)
-- stopped granting DELETE but did not revoke the DELETE already applied to live
-- databases, so it persisted across redeploys. Strip it here so a redeploy or a
-- restore self-heals and matches the worker boot check assertDbRoles
-- (Codex c96283d P2 / fca9ac8 P2 #4). UPDATE is retained: the projection workers
-- upsert these rows.
REVOKE DELETE, TRUNCATE ON raw_artifacts FROM brain_raw_worker;
REVOKE DELETE, TRUNCATE ON canonical_journal_entry FROM brain_canonical_projector;
REVOKE DELETE, TRUNCATE ON ledger_obligations FROM brain_ledger_projector;

-- canonical_projection_log DELETE followed the same shape: it was granted to
-- brain_raw_worker (#330-adjacent grant, above) so repairParsedOutput could
-- force a stranded row to replay by hand-deleting its log entry. Migration
-- 0005 (services/canonical) gives the projector's pending predicate its own
-- source-version check, so a repair now only needs to bump
-- raw_parsed.extracted_at (already does) and the DELETE grant is unused.
-- Strip it so a redeploy or restore self-heals the same way the block above
-- does, instead of leaving a live database holding a wider grant than the
-- worker needs.
REVOKE DELETE, TRUNCATE ON canonical_projection_log FROM brain_raw_worker;

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
--   brain_mcp_reader          BRAIN_MCP_READER_DB_URL
--   brain_surface_gateway     BRAIN_SURFACE_GATEWAY_DB_URL
--   brain_surface_audit_writer BRAIN_SURFACE_GATEWAY_AUDIT_DB_URL
--   brain_auth                BRAIN_AUTH_DB_URL
--   brain_auth_audit_writer   BRAIN_AUTH_AUDIT_DB_URL
-- In NODE_ENV=production the api fails to boot if BRAIN_WIKI_DB_URL or any of
-- the eight §4 URLs is unset (services/api/src/composition/db-isolation.ts);
-- in dev/test each falls back to DATABASE_URL with a warning. The API runtime
-- no longer uses brain_privileged; it survives ONLY for the deploy-time seed
-- one-shot (docker-compose `seed`). Migrations run as the owner/superuser role.
