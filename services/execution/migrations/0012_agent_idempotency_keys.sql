-- agent_idempotency_keys — event-layer idempotency (1a.5). Blocks duplicate runs.
-- Key: tenant_id:event_type:object_type:object_id:agent_id:action:day_bucket.
-- The day_bucket suffix lets a still-true event (e.g. invoice.overdue) re-fire on a
-- later day and produce a new run. On hit: return duplicate_skipped with run_id;
-- do NOT invoke the handler and do NOT emit audit (the original run already did).

BEGIN;

CREATE TABLE IF NOT EXISTS agent_idempotency_keys (
  id               TEXT        PRIMARY KEY,                -- agik_...
  tenant_id        TEXT        NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  run_id           TEXT        NOT NULL,                   -- soft ref: agent_runs(id)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE agent_idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_idempotency_keys
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_idempotency_keys
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
