-- Forward-only canonical categorization for Ledger transactions.
--
-- ledger_categories remains tenant-local. canonical_code gives a local category
-- a stable cross-tenant meaning, while assignment history makes corrections
-- explicit and auditable instead of silently overwriting category_id.

BEGIN;

ALTER TABLE ledger_categories
  ADD COLUMN IF NOT EXISTS canonical_code TEXT;

ALTER TABLE ledger_categories
  ADD CONSTRAINT ledger_categories_canonical_code_format
  CHECK (
    canonical_code IS NULL
    OR canonical_code ~ '^(income|expense)\\.[a-z0-9_]+$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_categories_tenant_canonical_code
  ON ledger_categories (tenant_id, canonical_code)
  WHERE canonical_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_transaction_category_assignments (
  id                TEXT        PRIMARY KEY,
  tenant_id         TEXT        NOT NULL,
  transaction_id    TEXT        NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
  category_id       TEXT        NOT NULL REFERENCES ledger_categories(id) ON DELETE RESTRICT,
  canonical_code    TEXT        NOT NULL CHECK (canonical_code ~ '^(income|expense)\\.[a-z0-9_]+$'),
  assignment_method TEXT        NOT NULL CHECK (assignment_method IN (
                              'source_provided', 'deterministic_rule', 'human_confirmed'
                            )),
  confidence        REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  rule_version      TEXT,
  source_category   TEXT,
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at     TIMESTAMPTZ,
  superseded_by     TEXT        REFERENCES ledger_transaction_category_assignments(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_transaction_category_assignment_active
  ON ledger_transaction_category_assignments (tenant_id, transaction_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_transaction_category_assignment_active_code
  ON ledger_transaction_category_assignments (tenant_id, canonical_code, transaction_id)
  WHERE superseded_at IS NULL;

ALTER TABLE ledger_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_transaction_category_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transaction_category_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ledger_transaction_category_assignments
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_transaction_category_assignments
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_transaction_category_assignments
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
