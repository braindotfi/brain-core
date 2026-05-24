-- H-20 outbound webhook dead-letter queue.
--
-- Outbound webhook delivery (shared/src/webhooks/outbound.ts) was best-effort
-- fire-and-forget: a failed POST was logged and lost. This table makes failures
-- durable so ops can see and replay them. Each (endpoint, event) failure upserts
-- one row with an attempt_count; a successful (re)delivery clears the row. Once
-- attempt_count reaches the cap (MAX_WEBHOOK_DELIVERY_ATTEMPTS = 5) the row is
-- "exhausted" — replay no longer auto-retries it (manual ops intervention),
-- which is how the outbound path now bounds retries instead of looping.
--
-- RLS armed here; co-located with webhook_endpoints (migration 0004). The
-- dispatcher writes it under the request tenant scope (app.tenant_id set).

BEGIN;

CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id               TEXT        PRIMARY KEY,                 -- wdl_...
  tenant_id        TEXT        NOT NULL,
  endpoint_id      TEXT        NOT NULL,                    -- webhook_endpoints.id
  event_id         TEXT        NOT NULL,                    -- evt_... audit event id
  event_type       TEXT        NOT NULL,
  payload          JSONB       NOT NULL,                    -- the exact signed body
  last_error       TEXT,
  attempt_count    INT         NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_endpoint
  ON webhook_dead_letters (tenant_id, endpoint_id, created_at);

ALTER TABLE webhook_dead_letters ENABLE ROW LEVEL SECURITY;

CREATE POLICY webhook_dead_letters_tenant_isolation
  ON webhook_dead_letters
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
