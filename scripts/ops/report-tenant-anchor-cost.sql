\pset pager off
\pset null '(null)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '1s';

\echo 'tenant anchor configuration'
SELECT id,
       kind,
       sandbox,
       created_via,
       audit_anchor_mode
  FROM tenants
 WHERE id = :'tenant_id';

\echo 'anchor root summary'
SELECT COUNT(*) AS total_roots,
       COUNT(*) FILTER (WHERE onchain_status = 'confirmed' AND onchain_tx_hash IS NOT NULL)
         AS confirmed_roots,
       COUNT(*) FILTER (WHERE onchain_status = 'pending' AND onchain_tx_hash IS NULL)
         AS pending_roots,
       COUNT(*) FILTER (WHERE onchain_status = 'reverted') AS reverted_roots,
       COUNT(DISTINCT onchain_tx_hash) FILTER (WHERE onchain_tx_hash IS NOT NULL)
         AS distinct_anchor_transactions,
       COALESCE(SUM(event_count) FILTER (
         WHERE onchain_status = 'confirmed' AND onchain_tx_hash IS NOT NULL
       ), 0) AS confirmed_events_covered,
       MIN(created_at) AS first_root_created_at,
       MAX(created_at) AS latest_root_created_at
  FROM audit_anchors
 WHERE tenant_id = :'tenant_id';

\echo 'confirmed roots by UTC day'
SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS utc_day,
       COUNT(*) AS roots,
       COUNT(DISTINCT onchain_tx_hash) AS transactions,
       SUM(event_count) AS events_covered,
       MIN(event_count) AS minimum_events_per_root,
       ROUND(AVG(event_count), 2) AS mean_events_per_root,
       MAX(event_count) AS maximum_events_per_root
  FROM audit_anchors
 WHERE tenant_id = :'tenant_id'
   AND onchain_status = 'confirmed'
   AND onchain_tx_hash IS NOT NULL
 GROUP BY 1
 ORDER BY 1;

\echo 'confirmed root transaction batches'
WITH target_transactions AS (
  SELECT onchain_tx_hash,
         COUNT(*) AS tenant_roots,
         SUM(event_count) AS tenant_events,
         MIN(created_at) AS first_target_root_at,
         MAX(created_at) AS last_target_root_at
    FROM audit_anchors
   WHERE tenant_id = :'tenant_id'
     AND onchain_status = 'confirmed'
     AND onchain_tx_hash IS NOT NULL
   GROUP BY onchain_tx_hash
), batch_totals AS (
  SELECT a.onchain_tx_hash,
         COUNT(*) AS batch_roots,
         COUNT(DISTINCT a.tenant_id) AS batch_tenants,
         SUM(a.event_count) AS batch_events
    FROM audit_anchors a
    JOIN target_transactions target USING (onchain_tx_hash)
   WHERE a.onchain_status = 'confirmed'
   GROUP BY a.onchain_tx_hash
)
SELECT '0x' || encode(target.onchain_tx_hash, 'hex') AS transaction_hash,
       target.tenant_roots,
       target.tenant_events,
       batch.batch_roots,
       batch.batch_tenants,
       batch.batch_events,
       target.first_target_root_at,
       target.last_target_root_at
  FROM target_transactions target
  JOIN batch_totals batch USING (onchain_tx_hash)
 ORDER BY target.first_target_root_at;

\echo 'corrected-rate counterfactual'
WITH ranked_events AS (
  SELECT ae.*,
         COALESCE(
           NULLIF(ae.inputs->>'transaction_id', ''),
           NULLIF(proposal.action->>'transaction_id', '')
         ) AS subject_transaction_id,
         ROW_NUMBER() OVER (
           PARTITION BY ae.actor,
                        ae.action,
                        COALESCE(
                          NULLIF(ae.inputs->>'transaction_id', ''),
                          NULLIF(proposal.action->>'transaction_id', '')
                        )
           ORDER BY ae.created_at, ae.id
         ) AS transaction_action_position
    FROM audit_events ae
    LEFT JOIN proposals proposal
      ON proposal.tenant_id = ae.tenant_id
     AND proposal.id = ae.inputs->>'proposal_id'
   WHERE ae.tenant_id = :'tenant_id'
), refresh_group_stats AS (
  SELECT actor,
         inputs->>'proposal_id' AS proposal_id,
         COUNT(*) AS refresh_count,
         COUNT(DISTINCT inputs) AS distinct_inputs,
         COUNT(DISTINCT outputs) AS distinct_outputs
    FROM ranked_events
   WHERE action = 'agent.action.refreshed'
     AND NULLIF(inputs->>'proposal_id', '') IS NOT NULL
   GROUP BY actor, inputs->>'proposal_id'
), classified_events AS (
  SELECT ranked.*,
         (
           ranked.actor = 'reconciliation'
           AND ranked.action = 'agent.action.proposed'
           AND ranked.subject_transaction_id IS NOT NULL
           AND ranked.transaction_action_position > 1
         ) AS reconciliation_duplicate,
         COALESCE(
           (
             ranked.action = 'agent.action.refreshed'
             AND ranked.before_state ? 'action'
             AND ranked.after_state ? 'action'
             AND ranked.before_state->'action' = ranked.after_state->'action'
             AND ranked.before_state->'policy_version'
                   IS NOT DISTINCT FROM ranked.after_state->'policy_version'
             AND ranked.before_state->'policy_decision'
                   IS NOT DISTINCT FROM ranked.after_state->'policy_decision'
             AND ranked.before_state->'required_approvers'
                   IS NOT DISTINCT FROM ranked.after_state->'required_approvers'
             AND ranked.before_state->'status' IS NOT DISTINCT FROM ranked.after_state->'status'
           ) OR (
             ranked.action = 'agent.action.refreshed'
             AND refresh.refresh_count > 1
             AND refresh.distinct_inputs = 1
             AND refresh.distinct_outputs = 1
           ),
           FALSE
         ) AS unchanged_refresh,
         (
           ranked.action = 'agent.action.superseded'
           AND ranked.actor = 'agent_proposal_subject_duplicate_cleanup'
         ) AS one_time_cleanup
    FROM ranked_events ranked
    LEFT JOIN refresh_group_stats refresh
      ON refresh.actor = ranked.actor
     AND refresh.proposal_id = ranked.inputs->>'proposal_id'
), root_event_counts AS (
  SELECT anchor.id,
         anchor.created_at,
         anchor.period_start,
         anchor.period_end,
         anchor.event_count,
         COUNT(event.id) AS observed_event_rows,
         COUNT(event.id) FILTER (
           WHERE NOT event.reconciliation_duplicate
             AND NOT event.unchanged_refresh
             AND NOT event.one_time_cleanup
         ) AS corrected_event_rows,
         COUNT(event.id) FILTER (WHERE event.reconciliation_duplicate)
           AS reconciliation_duplicate_rows,
         COUNT(event.id) FILTER (WHERE event.unchanged_refresh) AS unchanged_refresh_rows
    FROM audit_anchors anchor
    LEFT JOIN classified_events event
      ON event.created_at >= anchor.period_start
     AND event.created_at <= anchor.period_end
   WHERE anchor.tenant_id = :'tenant_id'
     AND anchor.onchain_status = 'confirmed'
     AND anchor.onchain_tx_hash IS NOT NULL
   GROUP BY anchor.id, anchor.created_at, anchor.period_start, anchor.period_end, anchor.event_count
), projection AS (
  SELECT *
    FROM root_event_counts
   WHERE period_end > :'projection_end'::timestamptz - :'projection_hours'::int * interval '1 hour'
     AND period_end <= :'projection_end'::timestamptz
), projection_events AS (
  SELECT COUNT(*) AS observed_events,
         COUNT(*) FILTER (
           WHERE NOT reconciliation_duplicate
             AND NOT unchanged_refresh
             AND NOT one_time_cleanup
         ) AS corrected_events,
         COUNT(*) FILTER (WHERE reconciliation_duplicate) AS reconciliation_duplicate_events,
         COUNT(*) FILTER (WHERE unchanged_refresh) AS unchanged_refresh_events,
         COUNT(*) FILTER (WHERE one_time_cleanup) AS one_time_cleanup_events
    FROM classified_events
   WHERE created_at > :'projection_end'::timestamptz - :'projection_hours'::int * interval '1 hour'
     AND created_at <= :'projection_end'::timestamptz
)
SELECT :'projection_end'::timestamptz - :'projection_hours'::int * interval '1 hour'
         AS projection_window_start,
       :'projection_end'::timestamptz AS projection_window_end,
       :'projection_hours'::int AS projection_hours,
       (SELECT observed_events FROM projection_events) AS observed_events,
       (SELECT corrected_events FROM projection_events) AS corrected_events,
       (SELECT reconciliation_duplicate_events FROM projection_events)
         AS reconciliation_duplicate_events,
       (SELECT unchanged_refresh_events FROM projection_events) AS unchanged_refresh_events,
       COUNT(*) AS observed_roots,
       COUNT(*) FILTER (WHERE corrected_event_rows > 0) AS corrected_roots,
       COUNT(*) FILTER (
         WHERE corrected_event_rows = 0
           AND reconciliation_duplicate_rows + unchanged_refresh_rows > 0
       ) AS bug_only_roots,
       ROUND(
         COUNT(*) FILTER (WHERE corrected_event_rows > 0)::numeric
           * 24 / :'projection_hours'::numeric,
         2
       ) AS projected_corrected_roots_per_day,
       ROUND(
         COUNT(*) FILTER (WHERE corrected_event_rows > 0)::numeric
           * 24 * 7 / :'projection_hours'::numeric,
         2
       ) AS projected_corrected_roots_per_week
  FROM projection;

\echo 'post-fix event observations'
WITH events AS (
  SELECT *
    FROM audit_events
   WHERE tenant_id = :'tenant_id'
     AND created_at >= :'fix_live_at'::timestamptz
)
SELECT :'fix_live_at'::timestamptz AS fix_live_at,
       now() AS observed_until,
       COUNT(*) AS all_events,
       COUNT(*) FILTER (
         WHERE action = 'agent.action.superseded'
           AND actor = 'agent_proposal_subject_duplicate_cleanup'
       ) AS one_time_cleanup_events,
       COUNT(*) FILTER (WHERE action = 'agent.action.proposed' AND actor = 'reconciliation')
         AS reconciliation_proposed_events,
       COUNT(*) FILTER (WHERE action = 'agent.action.refreshed') AS refresh_events
  FROM events;

COMMIT;
