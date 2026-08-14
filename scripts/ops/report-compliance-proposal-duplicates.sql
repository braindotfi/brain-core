\pset pager off
\pset null '(null)'
\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '1s';

\echo 'compliance_pending_proposal_summary'
WITH scoped AS (
  SELECT p.id,
         p.created_at,
         CASE
           WHEN NULLIF(p.action->>'policy_decision_id', '') IS NOT NULL THEN 'policy_decision_id'
           WHEN NULLIF(p.action->>'audit_event_id', '') IS NOT NULL THEN 'audit_event_id'
           ELSE NULL
         END AS subject_field,
         CASE
           WHEN NULLIF(p.action->>'policy_decision_id', '') IS NOT NULL THEN p.action->>'policy_decision_id'
           WHEN NULLIF(p.action->>'audit_event_id', '') IS NOT NULL THEN p.action->>'audit_event_id'
           ELSE NULL
         END AS subject_value
    FROM proposals p
   WHERE p.tenant_id = :'tenant_id'
     AND p.proposing_agent = 'compliance'
     AND p.status = 'pending'
), eligible AS (
  SELECT * FROM scoped WHERE subject_field IS NOT NULL AND subject_value IS NOT NULL
), grouped AS (
  SELECT subject_field, subject_value, count(*)::int AS proposal_count
    FROM eligible
   GROUP BY subject_field, subject_value
)
SELECT (SELECT count(*)::int FROM scoped) AS total_pending_compliance_proposals,
       (SELECT count(*)::int FROM eligible) AS subject_keyed_pending_proposals,
       (SELECT count(*)::int FROM scoped WHERE subject_field IS NULL) AS pending_without_stable_subject,
       (SELECT count(*)::int FROM grouped) AS distinct_subject_groups,
       (SELECT count(*)::int FROM grouped WHERE proposal_count > 1) AS duplicate_subject_groups,
       (SELECT coalesce(sum(proposal_count - 1), 0)::int FROM grouped WHERE proposal_count > 1)
         AS duplicate_pending_proposals,
       CASE
         WHEN (SELECT count(*) FROM scoped) BETWEEN 31 AND 32
          AND (SELECT count(*) FROM eligible) = (SELECT count(*) FROM scoped)
          AND (SELECT count(*) FROM grouped) = (SELECT count(*) FROM scoped)
           THEN 'inbox_cards_map_to_distinct_subjects'
         WHEN (SELECT count(*) FROM scoped) BETWEEN 31 AND 32
           THEN 'inbox_cards_map_to_fewer_or_unkeyed_subjects'
         ELSE 'pending_card_count_differs_from_inbox_observation'
       END AS inbox_subject_mapping;

\echo 'compliance_duplicate_subject_groups'
WITH scoped AS (
  SELECT p.id,
         p.created_at,
         CASE
           WHEN NULLIF(p.action->>'policy_decision_id', '') IS NOT NULL THEN 'policy_decision_id'
           WHEN NULLIF(p.action->>'audit_event_id', '') IS NOT NULL THEN 'audit_event_id'
           ELSE NULL
         END AS subject_field,
         CASE
           WHEN NULLIF(p.action->>'policy_decision_id', '') IS NOT NULL THEN p.action->>'policy_decision_id'
           WHEN NULLIF(p.action->>'audit_event_id', '') IS NOT NULL THEN p.action->>'audit_event_id'
           ELSE NULL
         END AS subject_value
    FROM proposals p
   WHERE p.tenant_id = :'tenant_id'
     AND p.proposing_agent = 'compliance'
     AND p.status = 'pending'
), eligible AS (
  SELECT * FROM scoped WHERE subject_field IS NOT NULL AND subject_value IS NOT NULL
)
SELECT subject_field,
       subject_value,
       count(*)::int AS proposal_count,
       (array_agg(id ORDER BY created_at ASC, id ASC))[1] AS oldest_proposal_id,
       min(created_at) AS oldest_created_at,
       (array_agg(id ORDER BY created_at DESC, id DESC))[1] AS newest_proposal_id,
       max(created_at) AS newest_created_at,
       bool_and(created_at < timestamptz '2026-08-13T12:33:55Z') AS all_rows_predate_dedupe_merge,
       bool_or(created_at >= timestamptz '2026-08-13T12:33:55Z') AS post_merge_rows_present
  FROM eligible
 GROUP BY subject_field, subject_value
HAVING count(*) > 1
 ORDER BY proposal_count DESC, oldest_created_at ASC, subject_field, subject_value;

\echo 'compliance_proposal_status_distribution'
SELECT status, count(*)::int AS proposal_count
  FROM proposals
 WHERE tenant_id = :'tenant_id'
   AND proposing_agent = 'compliance'
 GROUP BY status
 ORDER BY status;

COMMIT;
