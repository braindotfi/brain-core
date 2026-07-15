-- Direct-write Ledger dedup hardening (Tier 2 follow-up T2-22/T2-23).
--
-- The writer has always claimed INSERT ... ON CONFLICT semantics, but the
-- legacy implementation selected first and inserted second. These indexes are
-- the database side of the idempotency contract, so concurrent connector
-- writes serialize on the natural key instead of racing into duplicate rows.

BEGIN;

ALTER TABLE ledger_obligations
  ADD COLUMN IF NOT EXISTS external_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_counterparties_owner_normalized_type
  ON ledger_counterparties (owner_id, normalized_name, type)
  WHERE normalized_name IS NOT NULL AND canonical_counterparty_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_obligations_external_key
  ON ledger_obligations (owner_id, external_key)
  WHERE external_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_obligations_legacy_dedup
  ON ledger_obligations (owner_id, counterparty_id, type, amount_due, currency, due_date)
  WHERE external_key IS NULL;

COMMIT;
