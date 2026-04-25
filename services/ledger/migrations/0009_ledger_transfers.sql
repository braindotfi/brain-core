-- Brain Ledger — transfers (between two of the tenant's own accounts).
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
--
-- Pairs two transactions: one outflow on from_account, one inflow on
-- to_account. The transfer row is what reconciliation matches against to
-- avoid double-counting an inter-account move as both income and expense.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_transfers (
  id                       TEXT        PRIMARY KEY,                  -- xfer_<ulid>
  owner_id                 TEXT        NOT NULL,
  from_account_id          TEXT        NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  to_account_id            TEXT        NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  from_transaction_id      TEXT        REFERENCES ledger_transactions(id) ON DELETE SET NULL,
  to_transaction_id        TEXT        REFERENCES ledger_transactions(id) ON DELETE SET NULL,
  amount                   NUMERIC(28, 8) NOT NULL CHECK (amount > 0),
  currency                 TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  transfer_date            TIMESTAMPTZ NOT NULL,
  status                   TEXT        NOT NULL
                             CHECK (status IN ('proposed','in_flight','completed','failed')),
  source_ids               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Defense-in-depth: from and to must differ.
  CHECK (from_account_id <> to_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_transfers_owner_date
  ON ledger_transfers (owner_id, transfer_date DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_transfers_owner_from
  ON ledger_transfers (owner_id, from_account_id);

CREATE INDEX IF NOT EXISTS idx_ledger_transfers_owner_to
  ON ledger_transfers (owner_id, to_account_id);

ALTER TABLE ledger_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_transfers
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_transfers
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_transfers
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
