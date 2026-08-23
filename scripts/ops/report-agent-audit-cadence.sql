\pset pager off
\pset null '(null)'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

\echo 'tenant and audit bounds'
SELECT t.id,
       t.kind,
       t.sandbox,
       t.created_via,
       COUNT(ae.id) AS audit_event_count,
       MIN(ae.created_at) AS first_audit_at,
       MAX(ae.created_at) AS latest_audit_at
  FROM tenants t
  LEFT JOIN audit_events ae ON ae.tenant_id = t.id
 WHERE t.id = :'tenant_id'
 GROUP BY t.id, t.kind, t.sandbox, t.created_via;

\echo 'audit counts by action and actor'
SELECT action,
       actor,
       layer,
       COUNT(*) AS event_count,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS tenant_percent,
       MIN(created_at) AS first_at,
       MAX(created_at) AS latest_at
  FROM audit_events
 WHERE tenant_id = :'tenant_id'
 GROUP BY action, actor, layer
 ORDER BY event_count DESC, action, actor;

\echo 'audit counts by UTC day'
SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS utc_day,
       COUNT(*) AS event_count,
       COUNT(*) FILTER (WHERE action LIKE 'agent.%') AS agent_event_count,
       COUNT(*) FILTER (WHERE action = 'agent.action.refreshed') AS refreshed_count
  FROM audit_events
 WHERE tenant_id = :'tenant_id'
 GROUP BY 1
 ORDER BY 1;

\echo 'rolling audit windows'
SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '6 hours') AS last_6h,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '12 hours') AS last_12h,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS last_24h,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '36 hours') AS last_36h,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '48 hours') AS last_48h,
       COUNT(*) AS all_time
  FROM audit_events
 WHERE tenant_id = :'tenant_id';

\echo 'agent audit counts by actor and action'
SELECT actor,
       action,
       COUNT(*) AS event_count,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '36 hours') AS last_36h,
       MIN(created_at) AS first_at,
       MAX(created_at) AS latest_at
  FROM audit_events
 WHERE tenant_id = :'tenant_id'
   AND (action LIKE 'agent.%' OR layer = 'agent')
 GROUP BY actor, action
 ORDER BY event_count DESC, actor, action;

\echo 'agent runs by agent and status'
SELECT agent_id,
       status,
       COUNT(*) AS run_count,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '36 hours') AS last_36h,
       MIN(created_at) AS first_at,
       MAX(created_at) AS latest_at
  FROM agent_runs
 WHERE tenant_id = :'tenant_id'
 GROUP BY agent_id, status
 ORDER BY run_count DESC, agent_id, status;

\echo 'refreshed proposals by agent'
SELECT actor AS agent_id,
       COUNT(*) AS refresh_events,
       COUNT(DISTINCT inputs->>'proposal_id') AS proposal_count,
       ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT inputs->>'proposal_id'), 0), 2)
         AS refreshes_per_proposal,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '36 hours') AS last_36h
  FROM audit_events
 WHERE tenant_id = :'tenant_id'
   AND action = 'agent.action.refreshed'
 GROUP BY actor
 ORDER BY refresh_events DESC, actor;

\echo 'top refreshed proposal subjects'
WITH refreshes AS (
  SELECT id,
         actor,
         created_at,
         inputs->>'proposal_id' AS proposal_id,
         COALESCE(inputs->>'vendor_id', inputs->>'counterparty_id', inputs->>'invoice_id',
                  inputs->>'transaction_id', inputs->>'policy_decision_id',
                  inputs->>'audit_event_id') AS subject_id,
         inputs,
         outputs,
         created_at - LAG(created_at) OVER (
           PARTITION BY actor, inputs->>'proposal_id' ORDER BY created_at, id
         ) AS prior_gap
    FROM audit_events
   WHERE tenant_id = :'tenant_id'
     AND action = 'agent.action.refreshed'
)
SELECT actor,
       proposal_id,
       subject_id,
       COUNT(*) AS refresh_count,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '36 hours') AS last_36h,
       COUNT(DISTINCT inputs) AS distinct_inputs,
       COUNT(DISTINCT outputs) AS distinct_outputs,
       MIN(created_at) AS first_at,
       MAX(created_at) AS latest_at,
       MIN(prior_gap) AS minimum_gap,
       MAX(prior_gap) AS maximum_gap
  FROM refreshes
 GROUP BY actor, proposal_id, subject_id
 ORDER BY refresh_count DESC, actor, proposal_id
 LIMIT 30;

\echo 'vendor risk refresh timeline for the most refreshed proposal'
WITH top_vendor AS (
  SELECT inputs->>'proposal_id' AS proposal_id
    FROM audit_events
   WHERE tenant_id = :'tenant_id'
     AND action = 'agent.action.refreshed'
     AND actor = 'vendor_risk'
   GROUP BY inputs->>'proposal_id'
   ORDER BY COUNT(*) DESC, inputs->>'proposal_id'
   LIMIT 1
)
SELECT ae.id,
       ae.created_at,
       ae.inputs->>'proposal_id' AS proposal_id,
       COALESCE(ae.inputs->>'vendor_id', ae.inputs->>'counterparty_id') AS vendor_id,
       ae.inputs,
       ae.outputs
  FROM audit_events ae
  JOIN top_vendor tv ON tv.proposal_id = ae.inputs->>'proposal_id'
 WHERE ae.tenant_id = :'tenant_id'
   AND ae.action = 'agent.action.refreshed'
   AND ae.actor = 'vendor_risk'
 ORDER BY ae.created_at, ae.id;

\echo 'vendor risk current proposals'
SELECT id,
       status,
       created_at,
       updated_at,
       action->>'vendor_id' AS vendor_id,
       action->>'vendor_name' AS vendor_name,
       action->>'risk_band' AS risk_band,
       action->>'recommended_action' AS recommended_action,
       action->>'summary' AS summary
  FROM proposals
 WHERE tenant_id = :'tenant_id'
   AND proposing_agent = 'vendor_risk'
 ORDER BY updated_at DESC, id;

\echo 'vendor risk cooldown state'
SELECT trigger_key,
       receivable_id AS vendor_id,
       event,
       last_enqueued_at,
       last_status,
       run_id,
       proposal_id,
       updated_at
  FROM agent_trigger_cooldowns
 WHERE tenant_id = :'tenant_id'
   AND agent_key = 'vendor_risk'
 ORDER BY last_enqueued_at DESC, trigger_key;

COMMIT;
