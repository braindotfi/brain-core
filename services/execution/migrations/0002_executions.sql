BEGIN;

CREATE TABLE IF NOT EXISTS executions (
  id             TEXT        PRIMARY KEY,                 -- exec_...
  tenant_id      TEXT        NOT NULL,
  proposal_id    TEXT        NOT NULL REFERENCES proposals(id),
  rail           TEXT        NOT NULL
                  CHECK (rail IN ('bank_ach','erp_writeback','onchain_base','notification')),
  rail_receipt   JSONB,
  status         TEXT        NOT NULL
                  CHECK (status IN ('dispatched','in_flight','completed','failed')),
  idempotency_key TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_executions_tenant_status
  ON executions (tenant_id, status, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_executions_idempotency
  ON executions (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON executions
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON executions
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON executions
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
