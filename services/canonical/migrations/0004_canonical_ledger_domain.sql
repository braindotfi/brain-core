-- Canonical ledger domain for connector-sourced accounts and transactions.
-- Plaid, Stripe, and Finch raw_parsed rows converge here before Ledger projection.

BEGIN;

CREATE TABLE IF NOT EXISTS canonical_account (
  id                   TEXT        PRIMARY KEY,
  tenant_id            TEXT        NOT NULL,
  schema_version       INTEGER     NOT NULL DEFAULT 1,
  source_system        TEXT        NOT NULL,
  source_natural_key   TEXT        NOT NULL,
  institution          TEXT,
  external_account_id  TEXT,
  account_type         TEXT        NOT NULL CHECK (account_type IN (
                         'bank_checking','bank_savings','card','loan',
                         'line_of_credit','onchain','payment_processor'
                       )),
  name                 TEXT        NOT NULL,
  currency             TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  current_balance      NUMERIC(28, 8),
  available_balance    NUMERIC(28, 8),
  status               TEXT        NOT NULL CHECK (status IN (
                         'active','closed','frozen','pending'
                       )),
  provenance           TEXT        NOT NULL CHECK (provenance IN (
                         'extracted','agent_contributed','customer_asserted','human_confirmed'
                       )),
  confidence           REAL        CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  source_ids           TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  extensions           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_natural_key)
);

CREATE TABLE IF NOT EXISTS canonical_transaction (
  id                       TEXT        PRIMARY KEY,
  tenant_id                TEXT        NOT NULL,
  schema_version           INTEGER     NOT NULL DEFAULT 1,
  source_system            TEXT        NOT NULL,
  source_natural_key       TEXT        NOT NULL,
  canonical_account_id     TEXT        REFERENCES canonical_account(id) ON DELETE SET NULL,
  account_source_key       TEXT,
  canonical_counterparty_id TEXT       REFERENCES canonical_counterparty(id) ON DELETE SET NULL,
  counterparty_source_key  TEXT,
  amount                   NUMERIC(28, 8) NOT NULL CHECK (amount >= 0),
  currency                 TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction                TEXT        NOT NULL CHECK (direction IN (
                             'inflow','outflow','transfer','adjustment'
                           )),
  transaction_date         TIMESTAMPTZ NOT NULL,
  posted_date              TIMESTAMPTZ,
  status                   TEXT        NOT NULL CHECK (status IN (
                             'pending','posted','cleared','failed','reversed','disputed'
                           )),
  description_raw          TEXT,
  description_normalized   TEXT,
  reconciliation_status    TEXT        CHECK (
                             reconciliation_status IS NULL OR
                             reconciliation_status IN ('unreconciled','matched','partial','disputed')
                           ),
  provenance               TEXT        NOT NULL CHECK (provenance IN (
                             'extracted','agent_contributed','customer_asserted','human_confirmed'
                           )),
  confidence               REAL        CHECK (confidence IS NULL OR confidence BETWEEN 0.0 AND 1.0),
  source_ids               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  extensions               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_natural_key)
);

CREATE INDEX IF NOT EXISTS idx_canonical_account_tenant_updated
  ON canonical_account (tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_canonical_transaction_tenant_updated
  ON canonical_transaction (tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_canonical_transaction_account
  ON canonical_transaction (tenant_id, canonical_account_id)
  WHERE canonical_account_id IS NOT NULL;

ALTER TABLE canonical_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_account
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON canonical_account
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_account
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE canonical_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_transaction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_transaction
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON canonical_transaction
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_transaction
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
