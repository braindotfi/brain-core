\pset pager off
\pset null '(null)'
\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '1s';

\echo 'compliance_source_refs_summary'
WITH post_deploy AS (
  SELECT p.id,
         p.created_at,
         p.action->>'policy_decision_id' AS policy_decision_id
    FROM proposals p
   WHERE p.tenant_id = :'tenant_id'
     AND p.proposing_agent = 'compliance'
     AND p.status = 'pending'
     AND p.created_at >= timestamptz '2026-08-14T23:34:17Z'
), joined AS (
  SELECT p.id,
         p.created_at,
         p.policy_decision_id,
         pd.source_refs
    FROM post_deploy p
    LEFT JOIN policy_decisions pd
      ON pd.tenant_id = :'tenant_id'
     AND pd.id = p.policy_decision_id
)
SELECT COUNT(*)::int AS post_deploy_pending_compliance_proposals,
       COUNT(*) FILTER (WHERE policy_decision_id IS NOT NULL)::int AS policy_decision_linked_proposals,
       COUNT(*) FILTER (WHERE source_refs IS NOT NULL AND source_refs <> '{}'::jsonb)::int
         AS proposals_with_non_empty_source_refs,
       COUNT(*) FILTER (WHERE source_refs = '{}'::jsonb)::int AS proposals_with_empty_source_refs,
       COUNT(*) FILTER (WHERE policy_decision_id IS NULL)::int AS proposals_without_policy_decision_id,
       COUNT(*) FILTER (WHERE policy_decision_id IS NOT NULL AND source_refs IS NULL)::int
         AS proposals_with_missing_policy_decision
  FROM joined;

\echo 'compliance_source_refs_rows'
WITH post_deploy AS (
  SELECT p.id,
         p.created_at,
         p.action->>'policy_decision_id' AS policy_decision_id,
         p.action->>'audit_event_id' AS audit_event_id
    FROM proposals p
   WHERE p.tenant_id = :'tenant_id'
     AND p.proposing_agent = 'compliance'
     AND p.status = 'pending'
     AND p.created_at >= timestamptz '2026-08-14T23:34:17Z'
)
SELECT p.id AS proposal_id,
       p.created_at AS proposal_created_at,
       p.policy_decision_id,
       p.audit_event_id,
       pd.decided_at AS policy_decided_at,
       pd.subject_type,
       pd.subject_id,
       pd.source_refs,
       (pd.source_refs IS NOT NULL AND pd.source_refs <> '{}'::jsonb) AS source_refs_present
  FROM post_deploy p
  LEFT JOIN policy_decisions pd
    ON pd.tenant_id = :'tenant_id'
   AND pd.id = p.policy_decision_id
 ORDER BY p.created_at DESC, p.id DESC;

COMMIT;
