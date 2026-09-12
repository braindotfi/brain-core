-- One-time authoritative-state backfill. Runtime decision-state reads never
-- consult audit_events.

WITH latest_decision AS (
  SELECT DISTINCT ON (tenant_id, inputs->>'proposal_id')
         tenant_id,
         inputs->>'proposal_id' AS proposal_id,
         inputs->>'decision' AS decision,
         id AS decision_audit_id,
         created_at AS decided_at
    FROM audit_events
   WHERE action = 'proposal.decided'
     AND inputs->>'proposal_id' LIKE 'pi\_%' ESCAPE '\'
     AND inputs->>'decision' IN ('approve', 'reject', 'acknowledge', 'undo')
   ORDER BY tenant_id, inputs->>'proposal_id', created_at DESC, id DESC
)
UPDATE ledger_payment_intents AS intent
   SET decision = latest.decision,
       decision_audit_id = latest.decision_audit_id,
       decided_at = latest.decided_at
  FROM latest_decision AS latest
 WHERE intent.owner_id = latest.tenant_id
   AND intent.id = latest.proposal_id
   AND intent.decision IS NULL;
