-- RFC 0002 Phase B: human-login auth columns on `users`.
--
-- WHY HERE (not in services/api): migrations apply in service-alphabetical order
-- (`api/*` before `execution/*`), but the `users` table is created by
-- services/execution/0005_users.sql. The auth columns must therefore be added by
-- an `execution/*` migration so they run AFTER the table exists. Logical
-- ownership of identity stays with the api layer (it owns the WRITE path —
-- signup/login); only the physical migration location is dictated by ordering.
-- (Companion: services/api/0003_self_serve_onboarding.sql adds tenants columns +
-- email_verifications.)
--
-- Machine principals authenticate via SIWX + on-chain attestation and never get
-- a password_hash; only human (owner/operator) accounts do.
--
-- Forward-compatible: additive columns (nullable / defaulted) + a partial index;
-- existing rows continue to satisfy.

BEGIN;

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

COMMIT;
