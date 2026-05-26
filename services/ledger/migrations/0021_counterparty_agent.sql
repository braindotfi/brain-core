-- Agent counterparties (v0.4 / RFC 0001): a payee that is itself a registered
-- Brain agent (M2M / x402 settlement). Widens the type CHECK to add 'agent'
-- and adds a nullable agent_id link to the execution-layer agent registry.
-- No FK — agents live in another service; agent_id is an opaque id with a
-- format check. Forward-compatible: widens the CHECK only.

BEGIN;

ALTER TABLE ledger_counterparties
  DROP CONSTRAINT IF EXISTS ledger_counterparties_type_check;

ALTER TABLE ledger_counterparties
  ADD CONSTRAINT ledger_counterparties_type_check
  CHECK (type IN (
    'merchant','vendor','customer','employer','bank',
    'wallet','exchange','tax_authority','agent','other'
  ));

ALTER TABLE ledger_counterparties
  ADD COLUMN IF NOT EXISTS agent_id TEXT;

ALTER TABLE ledger_counterparties
  DROP CONSTRAINT IF EXISTS ledger_counterparties_agent_id_check;

ALTER TABLE ledger_counterparties
  ADD CONSTRAINT ledger_counterparties_agent_id_check
  CHECK (agent_id IS NULL OR agent_id ~ '^agent_[0-9A-HJKMNP-TV-Z]{26}$');

COMMENT ON COLUMN ledger_counterparties.agent_id IS
  'For type=agent: the execution-layer agent id this counterparty represents (RFC 0001). Opaque; no FK (cross-service).';

COMMIT;
