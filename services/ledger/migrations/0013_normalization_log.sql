-- Plaid normalization tracking log.
-- Owned by services/ledger. Records which raw_parsed rows have been promoted
-- to Ledger entities so the normalizeWorker can skip already-processed rows
-- without re-querying Ledger tables on every poll cycle.
--
-- No RLS: this is a system tracking table read by the worker process across
-- all tenants. It does not contain financial data.

BEGIN;

CREATE TABLE IF NOT EXISTS normalization_log (
  raw_parsed_id   TEXT        PRIMARY KEY,        -- raw_parsed.id (cross-service ref, no FK)
  tenant_id       TEXT        NOT NULL,           -- denormalized for observability
  parser          TEXT        NOT NULL,           -- e.g. plaid_tx_v1
  normalized_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  error           TEXT                            -- NULL on success; error message on failure
);

CREATE INDEX IF NOT EXISTS idx_normalization_log_tenant_parser
  ON normalization_log (tenant_id, parser, normalized_at DESC);

COMMIT;
