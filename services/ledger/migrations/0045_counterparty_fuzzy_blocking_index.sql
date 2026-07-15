-- Counterparty duplicate fuzzy blocking support (Tier 2 follow-up T2-4).
--
-- The matcher uses exact normalized-name equality for confident links and a
-- normalized-prefix block for fuzzy candidates. The text_pattern_ops index lets
-- prefix LIKE queries stay bounded instead of scanning every counterparty row.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ledger_counterparties_owner_normalized_prefix
  ON ledger_counterparties (owner_id, normalized_name text_pattern_ops)
  WHERE normalized_name IS NOT NULL;

COMMIT;
