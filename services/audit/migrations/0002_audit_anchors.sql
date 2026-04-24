-- Brain audit_anchors table.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 5.
-- Stage-7 extension of the audit_events schema from Stage 1.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_anchors (
  id                  TEXT        PRIMARY KEY,             -- anchor_...
  tenant_id           TEXT        NOT NULL,
  merkle_root         BYTEA       NOT NULL,
  event_count         INTEGER     NOT NULL CHECK (event_count >= 0),
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  onchain_tx_hash     BYTEA,                                -- null until tx broadcast
  onchain_block_number BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

-- §5.3 "the audit publisher tracks the last published root per tenant and
-- refuses to re-publish the same root" — enforced by the partial unique
-- index below plus application-level check in the publisher.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_anchors_tenant_root
  ON audit_anchors (tenant_id, merkle_root);

CREATE INDEX IF NOT EXISTS idx_audit_anchors_tenant_period
  ON audit_anchors (tenant_id, period_end DESC);

ALTER TABLE audit_anchors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_anchors
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON audit_anchors
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
