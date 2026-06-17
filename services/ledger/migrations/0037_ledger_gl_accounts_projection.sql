-- Ledger projection of the canonical chart of accounts (Phase 5 PR-C, RFC 0005).
--
-- The canonical layer (services/canonical) holds the rich chart of accounts in
-- canonical_gl_account. This table is the Ledger-side PROJECTION of it: a
-- read-projection the Ledger owns, regenerable from canonical without
-- recontacting providers (the Phase 5 acceptance criterion). It is the exact
-- analogue of the sanctioned Wiki-reads-Ledger read-projection, one layer up.
--
-- Why a dedicated table and not ledger_categories: ledger_categories is the
-- transaction-categorization surface (kind expense/income/transfer/other) with
-- a UNIQUE(tenant, name) that the full chart of accounts (which repeats names
-- across classifications, and includes balance-sheet asset/liability/equity
-- accounts that are not P&L categories) would fight. A purpose-built projection
-- table keeps semantics clean and touches no existing flow.
--
-- Canonical linkage is a SOFT reference (source_system + source_natural_key,
-- and the canonical row id as plain text), NOT a cross-service foreign key:
-- each service owns its own schema and stays independently migratable.
--
-- Rebuild + overlay: rows carry provenance. A provider-projected row is
-- 'extracted'; a human correction (e.g. a renamed account) is 'human_confirmed'
-- and is PRESERVED across a rebuild (the projector reapplies the overlay rather
-- than overwriting it with provider data) -- RFC 0005 §4.1.

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_gl_accounts (
  id                       TEXT        PRIMARY KEY,            -- Brain ULID: lgla_...
  tenant_id                TEXT        NOT NULL,
  source_system            TEXT        NOT NULL,                -- platform behind the aggregator (e.g. netsuite)
  source_natural_key       TEXT        NOT NULL,                -- stable remote account id
  canonical_gl_account_id  TEXT        NOT NULL,                -- soft ref to canonical_gl_account.id (no cross-service FK)
  name                     TEXT        NOT NULL,
  classification           TEXT        NOT NULL DEFAULT 'unknown'
                           CHECK (classification IN ('asset','liability','equity','revenue','expense','unknown')),
  account_number           TEXT,
  currency                 TEXT        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  status                   TEXT,
  provenance               TEXT        NOT NULL
                           CHECK (provenance IN ('extracted','agent_contributed','customer_asserted','human_confirmed')),
  confidence               REAL        NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_ids               TEXT[]      NOT NULL DEFAULT '{}',
  evidence_ids             TEXT[]      NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_natural_key)
);

CREATE INDEX IF NOT EXISTS idx_ledger_gl_accounts_tenant
  ON ledger_gl_accounts (tenant_id);

ALTER TABLE ledger_gl_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_gl_accounts
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON ledger_gl_accounts
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON ledger_gl_accounts
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE ledger_gl_accounts FORCE ROW LEVEL SECURITY;

COMMIT;
