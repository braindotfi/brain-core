-- Proposal-layer idempotency (Agent Autonomy v3, 1a.5). Blocks duplicate
-- proposals from the same run (LLM nondeterminism). Forward-compatible: additive
-- column + partial unique index, no rewrite of existing rows.

BEGIN;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS proposal_dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_proposals_tenant_dedup
  ON proposals (tenant_id, proposal_dedup_key)
  WHERE proposal_dedup_key IS NOT NULL;

COMMIT;
