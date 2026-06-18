-- Brain Canonical -- AP/AR + counterparty identity domain (Phase 5 deep refactor).
--
-- The accounting slice (0001) gave GL accounts and journal entries a rich home.
-- This adds the payable/receivable obligations and the counterparties they name,
-- so the Ledger's obligations and counterparties can become rebuildable
-- projections of canonical (the same move §12 makes for the whole compact
-- Ledger). This migration is ADDITIVE: a projector (PR-E) populates these from
-- the Merge invoice/contact pages already in raw_parsed; the live
-- merge_accounting extractor keeps writing the Ledger directly until the
-- projection is wired and cut over (PR-F/PR-G).
--
-- Same design rules as 0001: shared queryable fields are columns, provider-only
-- fields live in `extensions`, every record carries provenance + confidence +
-- source_ids/evidence_ids, and the (source_system, source_natural_key) pair is
-- the idempotency key so replay upserts in place.

BEGIN;

-- ---------------------------------------------------------------------------
-- Counterparties (organizations observed by a source system: vendor, customer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_counterparty (
  id                  TEXT        PRIMARY KEY,            -- Brain ULID: ccp_...
  tenant_id           TEXT        NOT NULL,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
  source_system       TEXT        NOT NULL,
  source_natural_key  TEXT        NOT NULL,                -- stable remote contact id
  name                TEXT        NOT NULL,
  normalized_name     TEXT,
  type                TEXT        NOT NULL DEFAULT 'other'
                      CHECK (type IN ('vendor','customer','employee','merchant','other')),
  email               TEXT,
  provenance          TEXT        NOT NULL
                      CHECK (provenance IN ('extracted','agent_contributed','customer_asserted','human_confirmed')),
  confidence          REAL        CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  source_ids          TEXT[]      NOT NULL DEFAULT '{}',
  evidence_ids        TEXT[]      NOT NULL DEFAULT '{}',
  extensions          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_natural_key)
);

CREATE INDEX IF NOT EXISTS idx_canonical_counterparty_tenant
  ON canonical_counterparty (tenant_id);

-- ---------------------------------------------------------------------------
-- Obligations (payable bills, receivable invoices).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_obligation (
  id                       TEXT        PRIMARY KEY,            -- Brain ULID: cob_...
  tenant_id                TEXT        NOT NULL,
  schema_version           INTEGER     NOT NULL DEFAULT 1,
  source_system            TEXT        NOT NULL,
  source_natural_key       TEXT        NOT NULL,                -- stable remote invoice id
  direction                TEXT        NOT NULL CHECK (direction IN ('payable','receivable')),
  type                     TEXT        NOT NULL,                -- bill, invoice, ...
  canonical_counterparty_id TEXT       REFERENCES canonical_counterparty(id) ON DELETE SET NULL,
  counterparty_source_key  TEXT,                                -- remote contact ref (resolves to canonical_counterparty_id)
  amount                   NUMERIC(38,8) NOT NULL CHECK (amount >= 0),
  currency                 TEXT        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  issue_date               TIMESTAMPTZ,
  due_date                 TIMESTAMPTZ,
  status                   TEXT,
  provenance               TEXT        NOT NULL
                           CHECK (provenance IN ('extracted','agent_contributed','customer_asserted','human_confirmed')),
  confidence               REAL        CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  source_ids               TEXT[]      NOT NULL DEFAULT '{}',
  evidence_ids             TEXT[]      NOT NULL DEFAULT '{}',
  extensions               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_natural_key)
);

CREATE INDEX IF NOT EXISTS idx_canonical_obligation_tenant
  ON canonical_obligation (tenant_id);
CREATE INDEX IF NOT EXISTS idx_canonical_obligation_counterparty
  ON canonical_obligation (canonical_counterparty_id);

-- ---------------------------------------------------------------------------
-- RLS (armed here, enforced under brain_app + FORCE per infra/db-roles.sql).
-- ---------------------------------------------------------------------------
ALTER TABLE canonical_counterparty ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_counterparty
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON canonical_counterparty
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_counterparty
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE canonical_counterparty FORCE ROW LEVEL SECURITY;

ALTER TABLE canonical_obligation ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_obligation
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON canonical_obligation
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_obligation
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE canonical_obligation FORCE ROW LEVEL SECURITY;

COMMIT;
