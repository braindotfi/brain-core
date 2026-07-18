-- PaymentIntent agent-output gate signals.
--
-- `confidence` already existed. These optional fields complete the policy VM
-- input set for agent.evidence_score.gte and agent.risk_level.lte on money-path
-- proposals. NULL means unknown and the VM fails closed for rules that require
-- the signal.

BEGIN;

ALTER TABLE ledger_payment_intents
  ADD COLUMN IF NOT EXISTS evidence_score REAL
    CHECK (evidence_score IS NULL OR (evidence_score >= 0.0 AND evidence_score <= 1.0)),
  ADD COLUMN IF NOT EXISTS risk_level TEXT
    CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high', 'critical'));

COMMIT;
