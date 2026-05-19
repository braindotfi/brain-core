-- Policy decisions table — proof artifacts from §6 pre-execution gate.
-- Owned by services/policy. One row per evaluate() call.
-- The §6 gate requires a stored PolicyDecision before any PaymentIntent
-- can transition to executed.

BEGIN;

CREATE TABLE IF NOT EXISTS policy_decisions (
  id                    TEXT        PRIMARY KEY,               -- pd_<ulid>
  tenant_id             TEXT        NOT NULL,
  policy_id             TEXT        NOT NULL,                  -- policies.id (no FK — cross-state snapshot)
  policy_version        INTEGER     NOT NULL,
  subject_type          TEXT        NOT NULL
                          CHECK (subject_type IN ('payment_intent', 'wiki_question', 'agent_action')),
  subject_id            TEXT        NOT NULL,
  outcome               TEXT        NOT NULL
                          CHECK (outcome IN ('allow', 'confirm', 'reject')),
  matched_rule_id       TEXT,
  required_approvers    TEXT[]      NOT NULL DEFAULT '{}',
  ledger_snapshot_hash  TEXT        NOT NULL,
  trace                 JSONB       NOT NULL DEFAULT '[]',
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_tenant_subject
  ON policy_decisions (tenant_id, subject_type, subject_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_policy_decisions_tenant_policy
  ON policy_decisions (tenant_id, policy_id, decided_at DESC);

ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON policy_decisions
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_write ON policy_decisions
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
