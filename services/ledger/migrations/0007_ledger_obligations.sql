-- Brain Ledger — obligations.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
--
-- Bills, invoices, subscriptions, loans, rent, payroll, taxes, card statements.
-- Carries amount_due / minimum_due / due_date and a status that tracks
-- whether the obligation has been paid.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_obligations (
  id                      TEXT        PRIMARY KEY,                  -- obl_<ulid>
  owner_id                TEXT        NOT NULL,
  type                    TEXT        NOT NULL
                            CHECK (type IN (
                              'bill','invoice','subscription','loan','rent',
                              'payroll','tax','card_statement','other'
                            )),
  counterparty_id         TEXT        NOT NULL REFERENCES ledger_counterparties(id) ON DELETE RESTRICT,
  amount_due              NUMERIC(28, 8) NOT NULL CHECK (amount_due >= 0),
  minimum_due             NUMERIC(28, 8) CHECK (minimum_due IS NULL OR minimum_due >= 0),
  currency                TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  due_date                TIMESTAMPTZ NOT NULL,
  recurrence              TEXT,                                     -- cron-ish or RFC 5545 RRULE
  status                  TEXT        NOT NULL
                            CHECK (status IN ('upcoming','due','paid','overdue','cancelled','disputed')),
  linked_transaction_ids  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_ids              TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids            TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  provenance              TEXT        NOT NULL
                            CHECK (provenance IN (
                              'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                            )),
  confidence              REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_obligations_owner_status_due
  ON ledger_obligations (owner_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_ledger_obligations_owner_counterparty
  ON ledger_obligations (owner_id, counterparty_id);

CREATE INDEX IF NOT EXISTS idx_ledger_obligations_open
  ON ledger_obligations (owner_id, due_date)
  WHERE status IN ('upcoming','due','overdue');

ALTER TABLE ledger_obligations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_obligations
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_obligations
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_obligations
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
