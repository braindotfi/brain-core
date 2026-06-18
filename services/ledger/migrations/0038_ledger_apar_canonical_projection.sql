-- Ledger AP/AR projection keys (Phase 5 deep refactor, PR-F, RFC 0005).
--
-- Adds the soft reference that lets ledger_obligations / ledger_counterparties
-- be rebuilt as a projection of the canonical AP/AR domain (canonical/0002),
-- the same move ledger_gl_accounts made for the chart of accounts (ledger/0037).
--
-- ADDITIVE and behaviour-neutral: the columns are nullable, no existing row is
-- touched, and the live Merge extractor keeps writing the Ledger directly. The
-- projection + rebuild added in this PR are callable + tested against a fresh
-- tenant; the cutover that makes canonical the source of truth (and backfills
-- these keys on existing rows) is a separate, heavily-verified PR.
--
-- The partial unique index is the projection's idempotency target: one Ledger
-- row per (tenant, canonical record). Rows the extractor wrote (canonical ref
-- NULL) are excluded, so the index does not constrain the legacy content-keyed
-- rows.

BEGIN;

ALTER TABLE ledger_obligations    ADD COLUMN IF NOT EXISTS canonical_obligation_id   TEXT;
ALTER TABLE ledger_counterparties ADD COLUMN IF NOT EXISTS canonical_counterparty_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_obligations_canonical
  ON ledger_obligations (owner_id, canonical_obligation_id)
  WHERE canonical_obligation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_counterparties_canonical
  ON ledger_counterparties (owner_id, canonical_counterparty_id)
  WHERE canonical_counterparty_id IS NOT NULL;

COMMIT;
