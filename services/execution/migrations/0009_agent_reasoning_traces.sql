-- agent_reasoning_traces — per-run LLM reasoning record with PII redaction (INV-9).
-- Agent Autonomy v3 (1a.3). Default reads return the redacted view; reading the
-- raw blob URIs requires the audit:incident_investigation scope (enforced in the
-- API/repository layer) and emits its own audit event per raw-read.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_reasoning_traces (
  id                      TEXT        PRIMARY KEY,         -- agrt_...
  tenant_id               TEXT        NOT NULL,
  agent_id                TEXT        NOT NULL,
  run_id                  TEXT        NOT NULL REFERENCES agent_runs(id),
  model_id                TEXT        NOT NULL,            -- e.g. claude-opus-4-7
  model_version           TEXT        NOT NULL,
  prompt_template_hash    BYTEA       NOT NULL,
  tool_manifest_hash      BYTEA       NOT NULL,
  retrieved_evidence_ids  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Redacted (default-read) views
  tool_calls_redacted     JSONB       NOT NULL,
  output_structured       JSONB       NOT NULL,
  redaction_policy_id     TEXT        NOT NULL,
  -- Raw blobs (encrypted at rest, per-tenant KMS; restricted-scope read)
  tool_calls_raw_uri      TEXT,
  tool_calls_raw_hash     BYTEA       NOT NULL,            -- proves raw matches redacted
  output_raw_uri          TEXT,
  output_raw_hash         BYTEA       NOT NULL,
  -- Metering
  llm_tokens_in           INT         NOT NULL,
  llm_tokens_out          INT         NOT NULL,
  llm_cost_usd            NUMERIC(12, 6) NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_reasoning_traces_run
  ON agent_reasoning_traces (run_id);

ALTER TABLE agent_reasoning_traces ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_reasoning_traces
  USING (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation_write ON agent_reasoning_traces
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMIT;
