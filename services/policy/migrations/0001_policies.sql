-- Brain policies table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 3 + Brain_Engineering_Standards.md §8.3.
-- Owner: services/policy.
--
-- State machine §8.3: draft → pending_signatures → active → deactivated.
-- Side states: cancelled (from draft), expired (from pending_signatures).
-- Only one policy per tenant is active at a time; activating version N+1
-- deactivates version N atomically (a trigger would enforce, but we do it
-- in the application with a serializable TX plus unique partial index).

BEGIN;

CREATE TABLE IF NOT EXISTS policies (
  id               TEXT        PRIMARY KEY,                -- Brain ULID: pol_...
  tenant_id        TEXT        NOT NULL,
  version          INTEGER     NOT NULL,
  content          JSONB       NOT NULL,                    -- canonical rule tree
  content_hash     BYTEA       NOT NULL,                    -- sha256 of canonical content
  signers          JSONB,                                   -- [{address, signature}]
  state            TEXT        NOT NULL
                    CHECK (state IN (
                      'draft','pending_signatures','active','deactivated','cancelled','expired'
                    )),
  quorum_required  INTEGER     NOT NULL DEFAULT 1 CHECK (quorum_required >= 1),
  activated_at     TIMESTAMPTZ,
  deactivated_at   TIMESTAMPTZ,
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

-- §8.3 "only one policy per tenant is active at a time" — partial unique idx.
CREATE UNIQUE INDEX IF NOT EXISTS uq_policies_tenant_active
  ON policies (tenant_id) WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_policies_tenant_state
  ON policies (tenant_id, state);

ALTER TABLE policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON policies
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON policies
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_update ON policies
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
