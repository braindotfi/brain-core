-- Brain Ledger — transactions.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
--
-- A single money-movement event. Inflow / outflow / transfer / adjustment.
-- amount is always non-negative; direction encodes the sign. This is the
-- post-Plaid convention; reconciles cleanly with cash-flow math.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id                       TEXT        PRIMARY KEY,                  -- tx_<ulid>
  owner_id                 TEXT        NOT NULL,
  account_id               TEXT        NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  external_transaction_id  TEXT,                                     -- e.g. Plaid transaction_id
  amount                   NUMERIC(28, 8) NOT NULL CHECK (amount >= 0),
  currency                 TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction                TEXT        NOT NULL
                             CHECK (direction IN ('inflow','outflow','transfer','adjustment')),
  transaction_date         TIMESTAMPTZ NOT NULL,
  posted_date              TIMESTAMPTZ,
  counterparty_id          TEXT        REFERENCES ledger_counterparties(id) ON DELETE SET NULL,
  category_id              TEXT        REFERENCES ledger_categories(id) ON DELETE SET NULL,
  status                   TEXT        NOT NULL
                             CHECK (status IN ('pending','posted','cleared','failed','reversed','disputed')),
  description_raw          TEXT,
  description_normalized   TEXT,
  source_ids               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  reconciliation_status    TEXT
                             CHECK (reconciliation_status IS NULL OR reconciliation_status IN (
                               'unreconciled','matched','partial','disputed'
                             )),
  provenance               TEXT        NOT NULL
                             CHECK (provenance IN (
                               'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                             )),
  confidence               REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Dedup: same external id from same source on same account is the same tx.
  UNIQUE (account_id, external_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_owner_date
  ON ledger_transactions (owner_id, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_owner_account_date
  ON ledger_transactions (owner_id, account_id, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_owner_counterparty
  ON ledger_transactions (owner_id, counterparty_id)
  WHERE counterparty_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_owner_status
  ON ledger_transactions (owner_id, status);

CREATE INDEX IF NOT EXISTS idx_ledger_transactions_unreconciled
  ON ledger_transactions (owner_id, transaction_date DESC)
  WHERE reconciliation_status = 'unreconciled' OR reconciliation_status IS NULL;

ALTER TABLE ledger_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_transactions
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_transactions
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_transactions
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
