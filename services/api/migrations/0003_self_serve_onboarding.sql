-- RFC 0002 Phase B: self-serve onboarding — tenant provisioning + human auth.
--
-- Ownership (RFC 0002 decision A): the api / identity layer now owns the
-- *evolving* users schema (auth columns below live here, not under
-- services/execution). services/execution keeps READING `users` for the boot
-- binary's resolveRole (approval routing) — a sanctioned cross-service READ
-- (CLAUDE.md §1). All WRITES to users now originate in the api layer (signup),
-- so no cross-service write boundary is crossed.
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

-- --- users: human-login credentials --------------------------------------
-- Machine principals authenticate via SIWX + on-chain attestation and never get
-- a password_hash; only human (owner/operator) accounts do.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT; -- scrypt$N$r$p$salt$dk; NULL for wallet-only / approval-only users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'disabled'));

COMMENT ON COLUMN users.password_hash IS
  'scrypt-serialized password hash (shared/src/auth/password.ts). NULL ⇒ no password login (wallet-only or approval-only user).';
COMMENT ON COLUMN users.status IS 'pending (email unverified) | active | disabled.';

-- Global (cross-tenant) unique email for PASSWORD-LOGIN users only. Approval-only
-- seed users (password_hash IS NULL) are excluded, so this does not clash with
-- existing per-tenant rows from 0005_users.sql. Unique indexes are enforced
-- beneath RLS, so signup correctly rejects a taken email even across tenants
-- (surfaces as the 23505 → signup_email_taken mapping in provisionTenant).
CREATE UNIQUE INDEX IF NOT EXISTS users_login_email_unique
  ON users (lower(email))
  WHERE password_hash IS NOT NULL;

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
