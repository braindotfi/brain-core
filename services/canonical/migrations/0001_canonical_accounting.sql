-- Brain Canonical -- rich accounting domain (ingestion architecture §12, Phase 5).
--
-- The canonical layer keeps rich, versioned domain records and projects the
-- compact Ledger and Wiki surfaces from them. This first slice is the
-- accounting domain: GL accounts, journal entries, and journal lines. These
-- already arrive from the Merge accounting aggregator and sit unprojected in
-- raw_parsed (merge_accounting_v1 pages of object_type gl_account /
-- journal_entry / payment / tax_rate) because the compact Ledger has no home
-- that preserves double-entry structure. This layer is that home.
--
-- Design rules (§12):
--  - Shared, queryable canonical fields are real columns. Provider-only fields
--    live in namespaced `extensions` JSONB, never flattened into shared columns.
--  - Every record carries provenance + confidence + source_ids (raw_artifact)
--    + evidence_ids (raw_parsed), so the layer is provenance-complete (§1.1).
--  - Records are rebuildable projections of raw_parsed: the (source_system,
--    source_natural_key) pair is a stable idempotency key, so replay upserts in
--    place rather than duplicating. canonical_projection_log tracks which
--    raw_parsed rows a projector has consumed (mirrors raw_interpretation_log /
--    normalization_log), so a rebuild can be driven from history alone.
--
-- Layer boundary: Canonical is downstream of Raw and upstream of Ledger. It
-- never reads Wiki or Policy. Writes flow upward into Ledger projections only.

BEGIN;

-- ---------------------------------------------------------------------------
-- GL accounts (the chart of accounts as observed from a source system).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_gl_account (
  id                  TEXT        PRIMARY KEY,            -- Brain ULID: cgla_...
  tenant_id           TEXT        NOT NULL,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
  source_system       TEXT        NOT NULL,                -- e.g. 'netsuite' (the platform behind the aggregator)
  source_natural_key  TEXT        NOT NULL,                -- stable remote account id (idempotency key)
  name                TEXT        NOT NULL,
  classification      TEXT        NOT NULL DEFAULT 'unknown'
                      CHECK (classification IN ('asset','liability','equity','revenue','expense','unknown')),
  account_number      TEXT,
  currency            TEXT        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  status              TEXT,
  provenance          TEXT        NOT NULL
                      CHECK (provenance IN ('extracted','agent_contributed','customer_asserted','human_confirmed')),
  confidence          REAL        CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  source_ids          TEXT[]      NOT NULL DEFAULT '{}',   -- raw_artifact ids
  evidence_ids        TEXT[]      NOT NULL DEFAULT '{}',   -- raw_parsed ids
  extensions          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_system, source_natural_key)
);

CREATE INDEX IF NOT EXISTS idx_canonical_gl_account_tenant
  ON canonical_gl_account (tenant_id);

-- ---------------------------------------------------------------------------
-- Journal entries (the double-entry header).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_journal_entry (
  id                  TEXT        PRIMARY KEY,            -- Brain ULID: cje_...
  tenant_id           TEXT        NOT NULL,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
  source_system       TEXT        NOT NULL,
  source_natural_key  TEXT        NOT NULL,                -- stable remote journal id (idempotency key)
  posted_at           TIMESTAMPTZ,
  memo                TEXT,
  currency            TEXT        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  status              TEXT,
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

CREATE INDEX IF NOT EXISTS idx_canonical_journal_entry_tenant_posted
  ON canonical_journal_entry (tenant_id, posted_at);

-- ---------------------------------------------------------------------------
-- Journal lines (the debit/credit legs). Child of a journal entry; the GL
-- account reference is kept as the raw remote key AND, once the account is
-- projected, the resolved canonical_gl_account id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_journal_line (
  id                  TEXT        PRIMARY KEY,            -- Brain ULID: cjl_...
  tenant_id           TEXT        NOT NULL,
  journal_entry_id    TEXT        NOT NULL REFERENCES canonical_journal_entry(id) ON DELETE CASCADE,
  line_number         INTEGER     NOT NULL,
  gl_account_id       TEXT        REFERENCES canonical_gl_account(id) ON DELETE SET NULL,
  gl_account_key      TEXT,                                -- remote account ref (resolves to gl_account_id)
  direction           TEXT        NOT NULL CHECK (direction IN ('debit','credit')),
  amount              NUMERIC(38,8) NOT NULL CHECK (amount >= 0),
  currency            TEXT        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  description         TEXT,
  extensions          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (journal_entry_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_canonical_journal_line_entry
  ON canonical_journal_line (journal_entry_id);

CREATE INDEX IF NOT EXISTS idx_canonical_journal_line_account
  ON canonical_journal_line (gl_account_id);

-- ---------------------------------------------------------------------------
-- Projection log: which raw_parsed rows a canonical projector has consumed.
-- One row per (raw_parsed_id) so the projector polls only unconsumed rows; an
-- operator-driven rebuild deletes log rows to re-derive from history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_projection_log (
  raw_parsed_id       TEXT        PRIMARY KEY,
  tenant_id           TEXT        NOT NULL,
  projector           TEXT        NOT NULL,                -- e.g. 'merge_accounting_canonical_v1'
  domain              TEXT        NOT NULL,                -- e.g. 'accounting'
  records_written     INTEGER     NOT NULL DEFAULT 0,
  error               TEXT,                                -- NULL on success
  projected_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_projection_log_tenant
  ON canonical_projection_log (tenant_id);

-- ---------------------------------------------------------------------------
-- §1 principle 2: row-level security on every tenant-scoped table. RLS is
-- ARMED here and ENFORCED under the non-owner brain_app role + FORCE (see
-- infra/db-roles.sql). The privileged projector role reads cross-tenant.
-- ---------------------------------------------------------------------------
ALTER TABLE canonical_gl_account ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_gl_account
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON canonical_gl_account
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_gl_account
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE canonical_gl_account FORCE ROW LEVEL SECURITY;

ALTER TABLE canonical_journal_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_journal_entry
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON canonical_journal_entry
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_journal_entry
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE canonical_journal_entry FORCE ROW LEVEL SECURITY;

ALTER TABLE canonical_journal_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_journal_line
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON canonical_journal_line
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_journal_line
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE canonical_journal_line FORCE ROW LEVEL SECURITY;

ALTER TABLE canonical_projection_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_projection_log
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_insert ON canonical_projection_log
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON canonical_projection_log
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE canonical_projection_log FORCE ROW LEVEL SECURITY;

COMMIT;
