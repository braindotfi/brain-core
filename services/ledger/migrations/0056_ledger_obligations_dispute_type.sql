-- Widen ledger_obligations.type to accept 'dispute'.
--
-- services/canonical/src/projectors/connector-ledger.ts's Stripe dispute
-- projector has always written canonical_obligation.type = 'dispute'
-- (canonical_obligation.type is unconstrained TEXT). The Ledger's canonical
-- projection (services/ledger/src/projection/obligations.ts) passes
-- row.type verbatim into this column's INSERT, so any tenant with a Stripe
-- account that ever had a chargeback hit a 23514 check_violation here -- and,
-- before services/ledger/migrations/0055_ledger_projection_quarantine.sql,
-- that one bad row wedged the whole cross-tenant projection cycle.
--
-- A dispute is a genuine obligation type (money the business may owe back to
-- a customer, or is contesting), not a degenerate 'other' -- so this widens
-- the vocabulary rather than flattening the projector's output. The allowed
-- set here must stay in lockstep with LEDGER_OBLIGATION_TYPES
-- (shared/src/ledger-vocab.ts), the single source of truth both the Ledger
-- extractor (services/ledger/src/extractors/doc-obligation.ts) and the
-- canonical connector/doc-obligation projectors import; a guard test
-- (connector-ledger.test.ts) fails CI if a projector's literal type ever
-- drifts from that list again.

BEGIN;

ALTER TABLE ledger_obligations DROP CONSTRAINT IF EXISTS ledger_obligations_type_check;
ALTER TABLE ledger_obligations ADD CONSTRAINT ledger_obligations_type_check
  CHECK (type IN (
    'bill','invoice','subscription','loan','rent',
    'payroll','tax','card_statement','dispute','other'
  ));

COMMIT;
