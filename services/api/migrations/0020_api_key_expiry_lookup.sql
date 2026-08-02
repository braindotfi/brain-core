-- Add nullable expiry and an efficient lookup path for first-class Brain API keys.
-- Existing keys remain valid because expires_at is nullable. The authenticator
-- rejects keys whose expires_at is in the past when the field is populated.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix_last4_created
  ON api_keys (key_prefix, key_last4, created_at DESC, id DESC);

COMMENT ON COLUMN api_keys.expires_at IS
  'Optional expiration timestamp. Null means the key does not expire before explicit revocation.';
