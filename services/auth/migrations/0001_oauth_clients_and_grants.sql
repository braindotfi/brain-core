-- Phase 2a OAuth authorization-server data model (OAUTH-AS-PLAN.md section 4).
--
-- Four tables: oauth_clients (DCR registrations), oauth_authorization_codes,
-- oauth_consent_grants, and oauth_refresh_tokens. No issued-access-token
-- table: access tokens are stateless JWTs with a 1h ceiling, revoked by jti
-- through the existing RedisRevocationStore. Adding a table would duplicate
-- the revocation store for no gain.
--
-- No FK to agents(tenant_id, id): the migration runner applies services/api/
-- migrations before services/execution/migrations (lexicographic service
-- order), so agents does not exist yet when this file would run on a fresh
-- database. `agents`, `users`, and `members` are all created in
-- services/execution/migrations, which sorts after services/auth. The same
-- trap applies to `member_id`. Referential integrity for `agent_id` and
-- `member_id` is enforced in application code at consent time, where the AS
-- reads and validates those rows anyway.
--
-- FORCE RLS backfill hazard, stated correctly (AUTH-PATHS-PLAN.md section 0):
-- the hazard is the ROLE, not the migration. Backfills work today only
-- because docker-compose.prod.yml runs `migrate` as the superuser `brain`,
-- which bypasses RLS including FORCE. The same SQL run from application code
-- or a non-superuser silently returns zero rows and reports success. All
-- four tables here are created empty, so this does not bite `0001` itself.
-- It WILL bite the first later migration that backfills from `agents` or
-- `members`; that migration must wrap its backfill in
-- `SET LOCAL row_security = off` or scope with `withTenantScope`.
--
-- Phase 2b design gap, recorded here for the next implementer: `brain_auth`
-- is NOBYPASSRLS (infra/db-roles.sql), so it cannot perform the pre-tenant
-- `code_hash -> row` and `token_hash -> row` lookups `/token` needs, because
-- with no `app.tenant_id` set the tenant_isolation policies on
-- oauth_authorization_codes and oauth_refresh_tokens return zero rows, not
-- an error. The AS will need a second `brain_resolver`-backed pool for those
-- lookups (`brain_resolver` already has SELECT on both tables,
-- infra/db-roles.sql). Neither `.env.example` nor `.env.prod.example`
-- documents a resolver URL for services/auth yet, so an operator would
-- otherwise hit a silent zero-row `/token` instead of a clear boot-time
-- error. Not built here.

BEGIN;

-- oauth_clients: Dynamic Client Registration records. Deliberately NOT
-- tenant scoped, because a DCR client registers before any tenant is known.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT        PRIMARY KEY, -- oacl_...
  client_name                TEXT        NOT NULL,
  redirect_uris              TEXT[]      NOT NULL,
  grant_types                TEXT[]      NOT NULL,
  response_types             TEXT[]      NOT NULL,
  token_endpoint_auth_method TEXT        NOT NULL DEFAULT 'none',
  software_id                TEXT,
  software_version           TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at                 TIMESTAMPTZ
);

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
-- Not a tenant_isolation policy: this table has no tenant_id. The
-- brain_auth_only policy stops any NOBYPASSRLS role other than brain_auth
-- from seeing or writing a row, so brain_app's blanket ON ALL TABLES grant
-- (infra/db-roles.sql) is contained by this policy rather than by REVOKE.
-- It does NOT stop a BYPASSRLS role holding an explicit grant: brain_resolver
-- is BYPASSRLS and is granted SELECT on this table (infra/db-roles.sql) as a
-- sanctioned cross-tenant reader for the pre-tenant client_id lookup /token
-- needs before RLS has an app.tenant_id to key on. Postgres evaluates
-- BYPASSRLS before any policy, so FORCE ROW LEVEL SECURITY (below) does not
-- re-arm it for brain_resolver either: FORCE only re-arms RLS for the table
-- OWNER, not for other BYPASSRLS roles.
CREATE POLICY brain_auth_only ON oauth_clients
  USING (current_user = 'brain_auth')
  WITH CHECK (current_user = 'brain_auth');
REVOKE ALL ON oauth_clients FROM PUBLIC;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE oauth_clients IS
  'DCR client registrations. Deliberately deviates from "RLS on every table + tenant_isolation policy" (Brain_Engineering_Standards.md): a client registers before any tenant is known, so there is no tenant_id to key a policy on. This is an accepted, documented deviation, not an oversight: a registered client carries ZERO authority until a tenant admin consents at /authorize, so a leaked row grants nothing on its own. RLS is armed (ENABLE plus FORCE) with a brain_auth_only policy that blocks every NOBYPASSRLS role, including brain_app despite its blanket grant, and PUBLIC is revoked outright. The one sanctioned exception is brain_resolver, a BYPASSRLS cross-tenant reader (the same role used for webhook/SIWX/login resolution) holding an explicit SELECT grant for the pre-tenant client_id lookup; BYPASSRLS roles are not subject to this or any RLS policy.';

-- oauth_authorization_codes: one-time PKCE codes, 60s TTL enforced in app
-- code, consumed atomically on exchange.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash              TEXT        PRIMARY KEY, -- sha256, plaintext never stored
  client_id               TEXT        NOT NULL,
  tenant_id                TEXT        NOT NULL REFERENCES tenants (id),
  agent_id                 TEXT        NOT NULL, -- no FK, see header
  member_id                TEXT        NOT NULL, -- granting admin, no FK
  grant_id                 TEXT        NOT NULL,
  scopes                   TEXT[]      NOT NULL,
  redirect_uri             TEXT        NOT NULL,
  code_challenge           TEXT        NOT NULL,
  code_challenge_method    TEXT        NOT NULL CHECK (code_challenge_method = 'S256'),
  resource                 TEXT,
  expires_at               TIMESTAMPTZ NOT NULL,
  consumed_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_tenant
  ON oauth_authorization_codes (tenant_id);

ALTER TABLE oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_authorization_codes
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON oauth_authorization_codes
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON oauth_authorization_codes
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE oauth_authorization_codes FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE oauth_authorization_codes IS
  'One-time PKCE authorization codes. Only sha256(code) is stored, never the plaintext. code_challenge_method is CHECK-constrained to S256 only: the database enforcing PKCE-S256-only so "plain" cannot even be stored. Consumption is a single atomic UPDATE ... SET consumed_at = now() WHERE consumed_at IS NULL AND expires_at > now() RETURNING *; a zero-row result is a hard reject, and a second presentation of an already-consumed code revokes the entire refresh-token family for that grant_id (RFC 6749 section 10.5).';

-- oauth_consent_grants: the durable record of what a tenant admin consented
-- to, including the on-chain scope attestation shown at consent time.
CREATE TABLE IF NOT EXISTS oauth_consent_grants (
  id                    TEXT        PRIMARY KEY, -- ogr_...
  tenant_id              TEXT        NOT NULL REFERENCES tenants (id),
  client_id               TEXT        NOT NULL,
  agent_id                TEXT        NOT NULL, -- no FK, see header
  member_id               TEXT        NOT NULL, -- no FK, see header
  scopes                  TEXT[]      NOT NULL,
  scope_hash_at_grant     BYTEA       NOT NULL, -- the on-chain hash verified at consent
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_consent_grants_tenant
  ON oauth_consent_grants (tenant_id);

ALTER TABLE oauth_consent_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_consent_grants
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON oauth_consent_grants
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON oauth_consent_grants
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE oauth_consent_grants FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE oauth_consent_grants IS
  'Durable record of a tenant admin''s consent decision. scope_hash_at_grant is the on-chain attestation hash the human was actually shown at consent time; if the tenant later rotates the agent''s on-chain scope set, a refresh exchange against this grant must fail rather than silently widen. Refresh re-reads this row and compares against agents.scope_hash.';

-- oauth_refresh_tokens: mirrors session_refresh_tokens field for field so
-- the rotation code lifted from production-tenancy/routes.ts works
-- unchanged.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash             TEXT        PRIMARY KEY,
  tenant_id                TEXT        NOT NULL REFERENCES tenants (id),
  agent_id                  TEXT        NOT NULL, -- no FK, see header
  client_id                 TEXT        NOT NULL,
  grant_id                  TEXT        NOT NULL,
  family_id                 TEXT        NOT NULL,
  token_id                  TEXT        NOT NULL,
  scopes                     TEXT[]      NOT NULL,
  expires_at                 TIMESTAMPTZ NOT NULL,
  rotated_at                  TIMESTAMPTZ,
  revoked_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_tenant
  ON oauth_refresh_tokens (tenant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens (family_id);

ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_refresh_tokens
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON oauth_refresh_tokens
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON oauth_refresh_tokens
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE oauth_refresh_tokens FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE oauth_refresh_tokens IS
  'Rotate-on-use refresh tokens for the OAuth core. Only sha256(token) is stored. family_id groups a rotation chain: presenting an already-rotated token revokes the whole family (RFC 6749 section 10.4 reuse detection), the same algorithm as production-tenancy/routes.ts session refresh. Refresh TTL 30 days to match the existing session convention.';

COMMIT;
