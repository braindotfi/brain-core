-- agent_runs — lifecycle record of one agent invocation. Agent Autonomy v3 (1a.3).
-- Created post-selection (an agent + resolved execution_mode exist). A no_match /
-- unscoped routing outcome is recorded only in agent_routing_decisions.
--
-- Cross-service ids (payment_intent_id -> ledger, policy_decision_id -> policy)
-- are SOFT references (no FK): each service owns its own schema. reasoning_trace_id
-- and routing_decision_id are soft refs too, to avoid a circular create order.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_runs (
  id                    TEXT        PRIMARY KEY,           -- agnr_...
  tenant_id             TEXT        NOT NULL,
  tenant_category       TEXT        NOT NULL,              -- business | consumer
  agent_id              TEXT        NOT NULL,
  agent_kind            TEXT        NOT NULL               -- internal | external (provenance)
                         CHECK (agent_kind IN ('internal','external')),
  event_type            TEXT,
  intent                TEXT,
  object_type           TEXT,
  object_id             TEXT,
  action                TEXT,
  execution_mode        TEXT        NOT NULL
                         CHECK (execution_mode IN ('execute','propose','confirm','notify_only','reject')),
  status                TEXT        NOT NULL
                         CHECK (status IN (
                           'routing','routed','no_match','unscoped','missing_handler',
                           'missing_action','missing_evidence','proposal_created',
                           'confirmation_required','executed','notify_only',
                           'rejected','failed','duplicate_skipped','paused','shadow_completed'
                         )),
  confidence            REAL,
  evidence_score        REAL,
  policy_status         TEXT
                         CHECK (policy_status IS NULL OR policy_status IN ('allow','confirm','reject','unknown')),
  proposal_id           TEXT,                              -- soft ref: proposals(id)
  payment_intent_id     TEXT,                              -- soft ref: ledger payment_intents (cross-service)
  policy_decision_id    TEXT,                              -- soft ref: policy_decisions (cross-service)
  idempotency_key       TEXT,
  reasoning_trace_id    TEXT,                              -- soft ref: agent_reasoning_traces(id)
  routing_decision_id   TEXT,                              -- soft ref: agent_routing_decisions(id)
  reason                JSONB       NOT NULL,
  failure_reason        TEXT,
  shadow_mode           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_status
  ON agent_runs (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent
  ON agent_runs (tenant_id, agent_id, created_at DESC);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_runs
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_runs
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_update ON agent_runs
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
             WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
