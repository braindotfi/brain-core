-- Brain Ledger — counterparties.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
-- The merchant / vendor / customer / employer / bank / wallet table.
-- Used by transactions, obligations, invoices, payment_intents.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_counterparties (
  id              TEXT        PRIMARY KEY,                 -- cp_<ulid>
  owner_id        TEXT        NOT NULL,                    -- tenant id, named owner_id per architecture spec
  name            TEXT        NOT NULL,
  normalized_name TEXT,                                    -- lowercased + ASCII-folded
  type            TEXT        NOT NULL
                    CHECK (type IN (
                      'merchant','vendor','customer','employer','bank',
                      'wallet','exchange','tax_authority','other'
                    )),
  risk_level      TEXT
                    CHECK (risk_level IS NULL OR risk_level IN ('low','medium','high','sanctioned')),
  verified_status TEXT
                    CHECK (verified_status IS NULL OR verified_status IN (
                      'unverified','self_attested','document_verified','sanctions_cleared'
                    )),
  aliases         TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  linked_accounts TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_ids      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],   -- raw_artifacts ids
  evidence_ids    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],   -- raw_parsed ids
  provenance      TEXT        NOT NULL
                    CHECK (provenance IN (
                      'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                    )),
  confidence      REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_counterparties_owner_type
  ON ledger_counterparties (owner_id, type);

CREATE INDEX IF NOT EXISTS idx_ledger_counterparties_owner_normalized
  ON ledger_counterparties (owner_id, normalized_name);

CREATE INDEX IF NOT EXISTS idx_ledger_counterparties_owner_risk
  ON ledger_counterparties (owner_id, risk_level)
  WHERE risk_level IN ('high','sanctioned');

ALTER TABLE ledger_counterparties ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_counterparties
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_counterparties
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_counterparties
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
