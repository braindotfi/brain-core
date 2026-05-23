-- policy_spend_counters — aggregate spend/tx-count per agent per rolling window
-- (Agent Autonomy v3, 1b.2). Per-tx caps don't bound aggregate harm; the gate
-- reads these to evaluate agent.spend_in_window / agent.tx_count_in_window and
-- increments them on a passing live gate (NOT in dry-run).

BEGIN;

CREATE TABLE IF NOT EXISTS policy_spend_counters (
  id            TEXT        PRIMARY KEY,                   -- psc_...
  tenant_id     TEXT        NOT NULL,
  agent_id      TEXT        NOT NULL,
  window        TEXT        NOT NULL,                      -- '1h' | '24h' | '7d' | '30d'
  bucket_start  TIMESTAMPTZ NOT NULL,
  amount        NUMERIC(28, 8) NOT NULL DEFAULT 0,
  tx_count      INTEGER     NOT NULL DEFAULT 0,
  currency      TEXT        NOT NULL,
  UNIQUE (tenant_id, agent_id, window, bucket_start, currency)
);

CREATE INDEX IF NOT EXISTS idx_policy_spend_counters_lookup
  ON policy_spend_counters (tenant_id, agent_id, window, currency, bucket_start DESC);

ALTER TABLE policy_spend_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy_spend_counters
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON policy_spend_counters
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON policy_spend_counters
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
