-- Brain Ledger — documents.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
--
-- A structured document derived from a Raw artifact. Receipts, invoices,
-- statements, contracts, payroll docs, tax docs. The document body lives
-- in Raw; this table holds the extracted/structured fields and the cross-
-- references to Ledger entities the document evidences.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_documents (
  id                       TEXT        PRIMARY KEY,                  -- doc_<ulid>
  owner_id                 TEXT        NOT NULL,
  document_type            TEXT        NOT NULL
                             CHECK (document_type IN (
                               'invoice','receipt','bank_statement','card_statement',
                               'contract','payroll','tax','other'
                             )),
  source_uri               TEXT,                                     -- pointer back to Raw blob
  extracted_fields         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  linked_account_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  linked_transaction_ids   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  linked_obligation_ids    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_ids               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence_ids             TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  confidence_score         REAL        CHECK (confidence_score IS NULL OR (confidence_score >= 0.0 AND confidence_score <= 1.0)),
  provenance               TEXT        NOT NULL
                             CHECK (provenance IN (
                               'extracted','inferred','ambiguous','human_confirmed','agent_contributed'
                             )),
  confidence               REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_documents_owner_type
  ON ledger_documents (owner_id, document_type);

CREATE INDEX IF NOT EXISTS idx_ledger_documents_owner_created
  ON ledger_documents (owner_id, created_at DESC);

ALTER TABLE ledger_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_documents
  USING (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_documents
  FOR INSERT WITH CHECK (owner_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_documents
  FOR UPDATE USING (owner_id = current_setting('app.tenant_id', true))
             WITH CHECK (owner_id = current_setting('app.tenant_id', true));

COMMIT;
