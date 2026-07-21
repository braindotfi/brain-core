-- API key issuance contract for BrainMVB Developers.
--
-- Migration 0013 introduced an operator-only token-exchange table. The public
-- contract now makes brain_sk_test_/brain_sk_live_ keys first-class bearer
-- credentials, issued and managed by tenant admins through /v1/tenants/:id/keys.
-- Keep this as a forward migration because 0013 is already on main.

BEGIN;

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_pkey;

DROP INDEX IF EXISTS idx_api_keys_key_id;

ALTER TABLE api_keys
  RENAME COLUMN token_hash TO hashed_secret;

ALTER TABLE api_keys
  RENAME COLUMN key_id TO id;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'sandbox',
  ADD COLUMN IF NOT EXISTS key_prefix TEXT NOT NULL DEFAULT 'brain_sk_test_',
  ADD COLUMN IF NOT EXISTS key_last4 TEXT NOT NULL DEFAULT '0000',
  ADD COLUMN IF NOT EXISTS rotated_from_id TEXT;

ALTER TABLE api_keys
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN hashed_secret SET NOT NULL,
  ALTER COLUMN scopes TYPE TEXT[]
    USING (
      CASE
        WHEN jsonb_typeof(scopes) = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(scopes))
        ELSE ARRAY[]::TEXT[]
      END
    );

ALTER TABLE api_keys
  ALTER COLUMN scopes SET NOT NULL;

ALTER TABLE api_keys
  DROP COLUMN IF EXISTS agent_id,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS token_hash,
  DROP COLUMN IF EXISTS key_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'api_keys_pkey'
       AND conrelid = 'api_keys'::regclass
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'api_keys_environment_check'
       AND conrelid = 'api_keys'::regclass
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_environment_check CHECK (environment IN ('sandbox', 'live'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'api_keys_rotated_from_id_fkey'
       AND conrelid = 'api_keys'::regclass
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_rotated_from_id_fkey
      FOREIGN KEY (rotated_from_id) REFERENCES api_keys (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_hashed_secret
  ON api_keys (hashed_secret);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_created
  ON api_keys (tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_api_keys_rotated_from
  ON api_keys (rotated_from_id)
  WHERE rotated_from_id IS NOT NULL;

COMMENT ON TABLE api_keys IS
  'Tenant-scoped Brain API keys. Plaintext brain_sk_test_/brain_sk_live_ secrets are returned once on issuance or rotation; only a SHA-256 hash with the server-side pepper is stored.';
COMMENT ON COLUMN api_keys.hashed_secret IS
  'SHA-256 digest of BRAIN_API_KEY_PEPPER || ''.'' || plaintext secret.';
COMMENT ON COLUMN api_keys.key_prefix IS
  'Display prefix only, for example brain_sk_test_ or brain_sk_live_.';
COMMENT ON COLUMN api_keys.key_last4 IS
  'Last four plaintext characters for display only.';
COMMENT ON COLUMN api_keys.rotated_from_id IS
  'Predecessor key revoked by POST /v1/keys/:id/rotate.';

COMMIT;
