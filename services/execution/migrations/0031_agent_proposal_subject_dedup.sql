-- Keep one actionable proposal per stable (agent, subject) pair for the
-- agent types confirmed producing duplicate pending findings. Collections has
-- its own invoice-specific index and refresh path in migration 0030.
--
-- The runtime advisory lock serializes read-then-insert. This migration does
-- not rewrite historical duplicates; cleanup is a separate guarded operation.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_proposals_vendor_risk_pending_vendor
  ON proposals (tenant_id, (action->>'vendor_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'vendor_risk'
    AND status = 'pending'
    AND action->>'vendor_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposals_vendor_risk_pending_counterparty
  ON proposals (tenant_id, (action->>'counterparty_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'vendor_risk'
    AND status = 'pending'
    AND action->>'vendor_id' IS NULL
    AND action->>'counterparty_id' IS NOT NULL;

-- Subscription and fraud findings are specific to one transaction.
CREATE INDEX IF NOT EXISTS idx_proposals_subscription_pending_txn
  ON proposals (tenant_id, (action->>'transaction_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'subscription'
    AND status = 'pending'
    AND action->>'transaction_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposals_fraud_anomaly_pending_txn
  ON proposals (tenant_id, (action->>'transaction_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'fraud_anomaly'
    AND status = 'pending'
    AND action->>'transaction_id' IS NOT NULL;

-- Compliance handlers may supply empty strings when an identifier is absent.
-- Treat them as absent so unrelated unresolved findings cannot collapse.
CREATE INDEX IF NOT EXISTS idx_proposals_compliance_pending_policy_decision
  ON proposals (tenant_id, (action->>'policy_decision_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'compliance'
    AND status = 'pending'
    AND action->>'policy_decision_id' IS NOT NULL
    AND action->>'policy_decision_id' <> '';

CREATE INDEX IF NOT EXISTS idx_proposals_compliance_pending_audit_event
  ON proposals (tenant_id, (action->>'audit_event_id'), created_at DESC, id DESC)
  WHERE proposing_agent = 'compliance'
    AND status = 'pending'
    AND (action->>'policy_decision_id' IS NULL OR action->>'policy_decision_id' = '')
    AND action->>'audit_event_id' IS NOT NULL
    AND action->>'audit_event_id' <> '';

COMMIT;
