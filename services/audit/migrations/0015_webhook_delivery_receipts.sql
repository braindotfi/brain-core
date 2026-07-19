-- BA-6 outbound webhook delivery receipts.
--
-- webhook_dead_letters records failed attempted delivery. This table records
-- successful delivery per endpoint and audit event so the dispatch worker can
-- reconcile committed audit_events whose first-hop setImmediate dispatch was
-- lost before it could attempt delivery.

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_delivery_receipts (
  tenant_id      TEXT        NOT NULL,
  endpoint_id    TEXT        NOT NULL,
  event_id       TEXT        NOT NULL,
  event_type     TEXT        NOT NULL,
  delivered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, endpoint_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_receipts_endpoint
  ON webhook_delivery_receipts (tenant_id, endpoint_id, delivered_at DESC);

ALTER TABLE webhook_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_delivery_receipts_tenant_isolation
  ON webhook_delivery_receipts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
