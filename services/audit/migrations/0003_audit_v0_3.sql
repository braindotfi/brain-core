-- audit_events — v0.3 columns for the §6 pre-execution gate.
-- Source of truth: Brain_MVP_Architecture.md §3 Layer 6 + Engineering
-- Standards §6 / §7.2.
--
-- Three things v0.3 needs that v0.1 didn't have:
--   1. layer values `ledger` and `agent` (the renamed/added layers).
--   2. policy_decision_id pointer so an audit event links to the
--      PolicyDecision that gated it. Required for the §6
--      audit-before / audit-after pair.
--   3. before_state / after_state JSONB so material state transitions
--      carry the values that changed. Optional but called for
--      explicitly in OpenAPI v0.2 + Engineering Standards §6.2.
--
-- Forward-compatible: the new columns are nullable and the CHECK is
-- broadened — existing v0.1 rows continue to satisfy.

BEGIN;

-- 1. Drop and re-add the layer CHECK with the broader enum.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'audit_events'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%layer%raw%wiki%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE audit_events DROP CONSTRAINT %I', con_name);
  END IF;
END$$;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_layer_v0_3_check
  CHECK (layer IN ('raw','ledger','wiki','policy','execution','agent','audit'));

-- 2. New columns.
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS policy_decision_id TEXT,
  ADD COLUMN IF NOT EXISTS before_state       JSONB,
  ADD COLUMN IF NOT EXISTS after_state        JSONB;

-- 3. Index for the §Audit endpoint /audit/entity/:type/:id which filters
--    on policy_decision_id when the entity is a PaymentIntent.
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_policy_decision
  ON audit_events (tenant_id, policy_decision_id)
  WHERE policy_decision_id IS NOT NULL;

COMMIT;
