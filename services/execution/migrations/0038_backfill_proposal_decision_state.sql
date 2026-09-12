-- One-time authoritative-state backfill. The request path never reads
-- audit_events; this migration copies each proposal's latest historical
-- proposal.decided receipt onto the proposal row once.

WITH latest_decision AS (
  SELECT DISTINCT ON (tenant_id, inputs->>'proposal_id')
         tenant_id,
         inputs->>'proposal_id' AS proposal_id,
         inputs->>'decision' AS decision,
         id AS decision_audit_id,
         created_at AS decided_at
    FROM audit_events
   WHERE action = 'proposal.decided'
     AND inputs->>'proposal_id' LIKE 'prop\_%' ESCAPE '\'
     AND inputs->>'decision' IN ('approve', 'reject', 'acknowledge', 'undo')
   ORDER BY tenant_id, inputs->>'proposal_id', created_at DESC, id DESC
)
UPDATE proposals AS proposal
   SET decision = latest.decision,
       decision_audit_id = latest.decision_audit_id,
       decided_at = latest.decided_at
  FROM latest_decision AS latest
 WHERE proposal.tenant_id = latest.tenant_id
   AND proposal.id = latest.proposal_id
   AND proposal.decision IS NULL;
