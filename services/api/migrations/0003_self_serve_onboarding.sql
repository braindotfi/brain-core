-- RFC 0002 Phase B: self-serve onboarding — tenant + email-verification schema.
--
-- Ownership (RFC 0002 decision A): the api / identity layer owns the evolving
-- identity schema and all WRITES to it (signup). services/execution keeps READING
-- `users` for the boot binary's resolveRole — a sanctioned cross-service READ
-- (CLAUDE.md §1).
--
-- Migration-ORDERING note: migrations apply in service-alphabetical order
-- (tools/migrate `{service}/{name}`), so every `api/*` migration runs BEFORE
-- every `execution/*` one. The `users` table is created by
-- services/execution/0005_users.sql, so the users auth-column additions CANNOT
-- live here (they would ALTER a not-yet-created table). They live in
-- services/execution/0021_users_auth_columns.sql (which runs after 0005).
-- This file therefore owns only tables api can create early: the `tenants`
-- columns (tenants is api/0001) and the new `email_verifications` table.
--
-- Safety: every new table arms RLS (ENABLE) under the same tenant predicate as
-- the rest of Brain; it is enforced under infra/db-roles.sql (FORCE RLS +
-- non-owner brain_app). Self-serve provisioning runs inside withTenantScope with
-- app.tenant_id set to a freshly-minted tenant id, so the INSERT WITH CHECK
-- policies pass for exactly that new tenant and nothing else.

BEGIN;

-- --- tenants: sandbox posture + provenance -------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS sandbox BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'admin'
    CHECK (created_via IN ('seed', 'admin', 'self_serve'));

COMMENT ON COLUMN tenants.sandbox IS
  'Self-serve tenants are sandbox=TRUE: read/propose only — never auto-promoted to LIVE_AGENTS, rails fail closed. Real money requires explicit promotion + audit.';
COMMENT ON COLUMN tenants.created_via IS 'Provenance of the tenant row: seed | admin | self_serve.';

-- NOTE: the `users` auth columns (password_hash / email_verified_at / status)
-- and the global login-email unique index live in
-- services/execution/0021_users_auth_columns.sql — see the ordering note above.

-- --- email_verifications: single-use, short-TTL tokens (stored hashed) ----
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash  TEXT        PRIMARY KEY,            -- sha256(raw token); the raw token is only ever emailed
  user_id     TEXT        NOT NULL,
  tenant_id   TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_user
  ON email_verifications (tenant_id, user_id);

ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_verifications
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON email_verifications
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON email_verifications
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
