-- Brain Ledger — accounts.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
-- A bank account, card, loan, line of credit, or on-chain address.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id                   TEXT        PRIMARY KEY,                 -- acct_<ulid>
  owner_id             TEXT        NOT NULL,
  institution          TEXT,
  external_account_id  TEXT,                                    -- e.g. Plaid account_id
  account_type         TEXT        NOT NULL
                         CHECK (account_type IN (
                           'bank_checking','bank_savings','card','loan',
                           'line_of_credit','onchain'
                         )),
  name                 TEXT        NOT NULL,
  currency             TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Stored as NUMERIC for FP-free arithmetic. The API returns strings.
  current_balance      NUMERIC(28, 8),
  available_balance    NUMERIC(28, 8),
  status               TEXT        NOT NULL
                         CHECK (status IN ('active','closed','frozen','pending')),
  source_ids           TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  provenance           TEXT        NOT NULL
                         CHECK (provenance IN (
                           'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                         )),
  confidence           REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- (owner_id, external_account_id) is the dedup key for source-driven ingestion.
  UNIQUE (owner_id, external_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner_status
  ON ledger_accounts (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner_type
  ON ledger_accounts (owner_id, account_type);

ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_accounts
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_accounts
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_accounts
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
