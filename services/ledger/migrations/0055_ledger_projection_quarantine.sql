-- Per-row quarantine for the canonical -> Ledger steady-state projection
-- workers (services/ledger/src/projection/obligations.ts, accounts-transactions.ts).
--
-- Before this migration a single bad canonical row (an obligation whose type
-- fails ledger_obligations' CHECK, an amount that overflows Ledger's narrower
-- NUMERIC width, a legacy dedup collision, etc.) threw out of the whole poll
-- loop. Each poll orders its batch by updated_at ASC, so the poison row was
-- first in every batch forever: no tenant ever got a new payable, receivable,
-- account, or transaction projected again, with only a rising
-- brain.ledger.apar_projection.lag_seconds gauge as a symptom -- a
-- cross-tenant denial of service with no per-row observability.
--
-- This adds a bounded retry budget plus an explicit quarantine flag, the same
-- shape already established twice in this codebase for the identical problem:
-- services/ledger/migrations/0043_normalization_retry_quarantine.sql
-- (normalization_log) and
-- services/canonical/migrations/0003_canonical_projection_quarantine.sql
-- (canonical_projection_log). A per-row failure is retried up to the worker's
-- attempt budget, then quarantined (excluded from the poll) so its siblings
-- and every other tenant keep projecting; an operator can clear
-- quarantined/attempts to replay a row once its root cause is fixed.
--
-- One shared table covers all four poll loops (canonical_counterparty,
-- canonical_obligation, canonical_account, canonical_transaction) instead of
-- four near-identical tables, keyed by (source_table, source_id).

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_projection_quarantine (
  source_table TEXT        NOT NULL
               CHECK (source_table IN ('canonical_counterparty', 'canonical_obligation',
                                        'canonical_account', 'canonical_transaction')),
  source_id    TEXT        NOT NULL,
  tenant_id    TEXT        NOT NULL,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  quarantined  BOOLEAN     NOT NULL DEFAULT false,
  error        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_id)
);

-- The poll's exclusion predicate scans this shape: one source_table's rows,
-- filtered to quarantined.
CREATE INDEX IF NOT EXISTS idx_ledger_projection_quarantine_pending
  ON ledger_projection_quarantine (source_table, quarantined);

-- A future quarantine-depth gauge or per-tenant replay only scans the
-- (expected small) quarantined set.
CREATE INDEX IF NOT EXISTS idx_ledger_projection_quarantine_tenant
  ON ledger_projection_quarantine (tenant_id)
  WHERE quarantined = true;

ALTER TABLE ledger_projection_quarantine ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_projection_quarantine
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON ledger_projection_quarantine
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_projection_quarantine
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE ledger_projection_quarantine FORCE ROW LEVEL SECURITY;

-- Self-heal the runtime role grant on deploy (matches migration 0051's
-- pattern), so an already-provisioned environment does not need
-- infra/db-roles.sql rerun before the worker can write this table. No-op in
-- local databases where the least-privilege role has not been created.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_ledger_projector') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ledger_projection_quarantine TO brain_ledger_projector';
  END IF;
END
$$;

COMMIT;
