-- agent_routing_decisions — one row per router invocation, even on no_match.
-- Agent Autonomy v3 (1a.3). Source of truth: docs/agent-autonomy-v3.md, plan 2.2.
-- INV-6: routing decisions (including no-match) are a material state change.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_routing_decisions (
  id                   TEXT        PRIMARY KEY,            -- agrd_...
  tenant_id            TEXT        NOT NULL,
  tenant_category      TEXT        NOT NULL,               -- business | consumer
  event_type           TEXT,
  intent               TEXT,
  selected_agent_id    TEXT,                               -- null on no_match / unscoped
  fallback_agent_ids   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  policy_status        TEXT        NOT NULL                -- routed | no_match | unscoped
                        CHECK (policy_status IN ('routed','no_match','unscoped')),
  confidence           REAL,
  evidence_score       REAL,
  reason               JSONB       NOT NULL,               -- structured multi-factor reason (2.2)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_routing_decisions_tenant
  ON agent_routing_decisions (tenant_id, created_at DESC);

ALTER TABLE agent_routing_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_routing_decisions
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_routing_decisions
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
