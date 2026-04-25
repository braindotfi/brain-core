-- Brain Ledger — categories.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 2.
-- Owner: services/ledger.
--
-- Categories are tenant-scoped labels used by transactions and obligations.
-- Hierarchical via parent_id. No FK to anywhere else; everything else FKs INTO categories.
-- Migration 0001 lands first because most other ledger tables FK to this.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_categories (
  id            TEXT        PRIMARY KEY,                  -- cat_<ulid>
  tenant_id     TEXT        NOT NULL,                     -- tnt_<ulid>
  name          TEXT        NOT NULL,
  parent_id     TEXT        REFERENCES ledger_categories(id) ON DELETE SET NULL,
  kind          TEXT        NOT NULL
                  CHECK (kind IN ('expense','income','transfer','other')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_ledger_categories_tenant_kind
  ON ledger_categories (tenant_id, kind);

ALTER TABLE ledger_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_categories
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON ledger_categories
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_categories
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
