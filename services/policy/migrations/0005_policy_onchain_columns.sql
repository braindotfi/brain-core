-- Store the on-chain registration tx and version on the policy row so that
-- repeated calls to POST /v1/demo/policy/activate with the same policy content
-- can return the existing registration without submitting a new chain tx.

BEGIN;

ALTER TABLE policies ADD COLUMN IF NOT EXISTS onchain_tx      TEXT;
ALTER TABLE policies ADD COLUMN IF NOT EXISTS onchain_version INTEGER;

COMMIT;
