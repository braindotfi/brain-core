-- Brain Ledger — invoices.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
--
-- Issued OR received invoices. The invoice is a structured representation;
-- linked_document_ids points back to the source document(s) in ledger_documents.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_invoices (
  id                      TEXT        PRIMARY KEY,                  -- inv_<ulid>
  owner_id                TEXT        NOT NULL,
  invoice_number          TEXT        NOT NULL,
  counterparty_id         TEXT        NOT NULL REFERENCES ledger_counterparties(id) ON DELETE RESTRICT,
  amount_due              NUMERIC(28, 8) NOT NULL CHECK (amount_due >= 0),
  amount_paid             NUMERIC(28, 8) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  currency                TEXT        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  issue_date              TIMESTAMPTZ NOT NULL,
  due_date                TIMESTAMPTZ,
  status                  TEXT        NOT NULL
                            CHECK (status IN ('draft','sent','partial','paid','overdue','cancelled','disputed')),
  linked_document_ids     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  linked_transaction_ids  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_ids              TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids            TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  provenance              TEXT        NOT NULL
                            CHECK (provenance IN (
                              'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                            )),
  confidence              REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Same vendor cannot bill the same invoice number twice for the same tenant.
  UNIQUE (owner_id, counterparty_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_ledger_invoices_owner_status
  ON ledger_invoices (owner_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_ledger_invoices_owner_counterparty
  ON ledger_invoices (owner_id, counterparty_id);

ALTER TABLE ledger_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_invoices
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_invoices
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_invoices
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
