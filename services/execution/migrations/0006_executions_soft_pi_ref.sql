-- Drop the hard FK from executions.proposal_id → proposals(id).
-- In v0.3 the execution layer creates PaymentIntents in ledger.payment_intents
-- (id prefix pi_), not in the v0.2 proposals table (prefix prop_).
-- The proposal_id column is kept as a soft reference; the application layer
-- enforces the link via PaymentIntentService.

BEGIN;

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_proposal_id_fkey;

COMMIT;
