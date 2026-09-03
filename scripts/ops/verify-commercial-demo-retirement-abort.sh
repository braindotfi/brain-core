#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_CONFIRMATION="VERIFY_1519_COMMERCIAL_DEMO_TENANTS_PRESERVED"
readonly EXPECTED_TARGET_SHA256="bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8"
readonly EXPECTED_TARGET_COUNT=1519
readonly PROTECTED_TENANTS=(
  tnt_00000000010000000000000000
  tnt_01KYAT7A1QRKHTYW9H4RAR2SEX
  tnt_01KYAT31JH0G043K77H8SKYG4N
  tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ
  tnt_01M1GTBQN8R8PB6X6PN73YB6NP
  tnt_01M1M64ZE1R8J9TB6C3DCRKA61
)

if [[ "${CONFIRMATION:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  echo "confirmation must equal $EXPECTED_CONFIRMATION"
  exit 1
fi
if [[ -z "${VM_HOST:-}" || -z "${VM_SSH_KEY:-}" ]]; then
  echo "VM_HOST and VM_SSH_KEY must be configured by the production workflow"
  exit 1
fi

ssh -i ~/.ssh/id_deploy -o ServerAliveInterval=30 "azureuser@$VM_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail

readonly TARGET_FILE="/tmp/commercial-demo-retirement-targets.csv"
readonly SNAPSHOT_FILE="/tmp/commercial-demo-retirement-agent-states.csv"
readonly FENCE_FILE="/tmp/commercial-demo-retirement-execution/fence-started-at.txt"
readonly EXPECTED_TARGET_SHA256="bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8"
readonly EXPECTED_TARGET_COUNT=1519
readonly PROTECTED_TENANTS=(
  tnt_00000000010000000000000000
  tnt_01KYAT7A1QRKHTYW9H4RAR2SEX
  tnt_01KYAT31JH0G043K77H8SKYG4N
  tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ
  tnt_01M1GTBQN8R8PB6X6PN73YB6NP
  tnt_01M1M64ZE1R8J9TB6C3DCRKA61
)

[[ -f "$TARGET_FILE" ]]
[[ -s "$SNAPSHOT_FILE" ]]
[[ -s "$FENCE_FILE" ]]
fence_started_at="$(tr -d '\r\n' < "$FENCE_FILE")"
if [[ ! "$fence_started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "invalid recorded fence timestamp"
  exit 1
fi

actual_target_sha256="$(sha256sum "$TARGET_FILE" | cut -d ' ' -f 1)"
[[ "$actual_target_sha256" == "$EXPECTED_TARGET_SHA256" ]]
target_count="$(tail -n +2 "$TARGET_FILE" | sed '/^$/d' | wc -l | tr -d ' ')"
[[ "$target_count" == "$EXPECTED_TARGET_COUNT" ]]
for tenant_id in "${PROTECTED_TENANTS[@]}"; do
  if grep -Fqx "$tenant_id" "$TARGET_FILE"; then
    echo "protected tenant reached target list: $tenant_id"
    exit 1
  fi
done

for container in brain-prod-worker brain-prod-agents; do
  running="$(docker inspect --format='{{.State.Running}}' "$container")"
  healthy="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
  if [[ "$running" != "true" || "$healthy" != "healthy" ]]; then
    echo "$container is not running and healthy"
    exit 1
  fi
done

docker cp "$TARGET_FILE" brain-prod-postgres:/tmp/commercial-demo-retirement-targets.csv
docker cp "$SNAPSHOT_FILE" brain-prod-postgres:/tmp/commercial-demo-retirement-agent-states.csv
docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 \
  -v fence_started_at="$fence_started_at" <<'SQL'
CREATE TEMP TABLE retirement_targets (tenant_id TEXT PRIMARY KEY);
\copy retirement_targets FROM '/tmp/commercial-demo-retirement-targets.csv' WITH (FORMAT csv, HEADER true)
CREATE TEMP TABLE expected_agent_states (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
);
\copy expected_agent_states FROM '/tmp/commercial-demo-retirement-agent-states.csv' WITH (FORMAT csv, HEADER true)

WITH verification AS (
  SELECT
    (SELECT COUNT(*) FROM retirement_targets) AS target_count,
    (
      SELECT COUNT(*)
        FROM tenants tenant
        JOIN retirement_targets target ON target.tenant_id = tenant.id
    ) AS remaining_tenants,
    (
      SELECT COUNT(*)
        FROM expected_agent_states expected
        FULL OUTER JOIN (
          SELECT candidate_agent.*
            FROM agents candidate_agent
            JOIN retirement_targets target ON target.tenant_id = candidate_agent.tenant_id
        ) agent
          ON agent.tenant_id = expected.tenant_id
         AND agent.id = expected.agent_id
       WHERE expected.agent_id IS NULL
          OR agent.id IS NULL
          OR agent.state <> expected.state
    ) AS agent_state_mismatches,
    (
      SELECT COUNT(*)
        FROM audit_events event
        JOIN retirement_targets target ON target.tenant_id = event.tenant_id
       WHERE event.created_at >= :'fence_started_at'::timestamptz
    ) AS audit_activity_after_fence,
    (
      SELECT COUNT(*)
        FROM agent_runs run
        JOIN retirement_targets target ON target.tenant_id = run.tenant_id
       WHERE run.created_at >= :'fence_started_at'::timestamptz
    ) AS agent_runs_after_fence,
    (
      SELECT COUNT(*)
        FROM proposals proposal
        JOIN retirement_targets target ON target.tenant_id = proposal.tenant_id
       WHERE proposal.created_at >= :'fence_started_at'::timestamptz
    ) AS proposals_after_fence
)
SELECT json_build_object(
  'event', 'commercial_demo_retirement_abort_verified',
  'candidate_list_sha256', 'bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8',
  'fence_started_at', :'fence_started_at',
  'target_count', target_count,
  'remaining_tenants', remaining_tenants,
  'agent_state_mismatches', agent_state_mismatches,
  'worker_healthy', true,
  'agents_healthy', true,
  'audit_activity_after_fence', audit_activity_after_fence,
  'agent_runs_after_fence', agent_runs_after_fence,
  'proposals_after_fence', proposals_after_fence
)::text
FROM verification;

SELECT json_build_object(
  'event', 'commercial_demo_retirement_post_fence_audit_detail',
  'tenant_id', event.tenant_id,
  'audit_event_id', event.id,
  'action', event.action,
  'created_at', event.created_at
)::text
  FROM audit_events event
  JOIN retirement_targets target ON target.tenant_id = event.tenant_id
 WHERE event.created_at >= :'fence_started_at'::timestamptz
 ORDER BY event.created_at, event.id;

SELECT json_build_object(
  'event', 'commercial_demo_retirement_post_fence_agent_run_detail',
  'tenant_id', run.tenant_id,
  'agent_run_id', run.id,
  'agent_id', run.agent_id,
  'created_at', run.created_at
)::text
  FROM agent_runs run
  JOIN retirement_targets target ON target.tenant_id = run.tenant_id
 WHERE run.created_at >= :'fence_started_at'::timestamptz
 ORDER BY run.created_at, run.id;

SELECT json_build_object(
  'event', 'commercial_demo_retirement_post_fence_proposal_detail',
  'tenant_id', proposal.tenant_id,
  'proposal_id', proposal.id,
  'status', proposal.status,
  'created_at', proposal.created_at
)::text
  FROM proposals proposal
  JOIN retirement_targets target ON target.tenant_id = proposal.tenant_id
 WHERE proposal.created_at >= :'fence_started_at'::timestamptz
 ORDER BY proposal.created_at, proposal.id;

WITH non_bootstrap AS (
  SELECT member.*, tenant.created_at AS tenant_created_at
    FROM members member
    JOIN retirement_targets target ON target.tenant_id = member.tenant_id
    JOIN tenants tenant ON tenant.id = member.tenant_id
   WHERE lower(member.email) NOT LIKE 'bootstrap+%@brain.invalid'
), classified AS (
  SELECT *,
         CASE
           WHEN lower(email) = 'approver2+' || lower(tenant_id) || '@brain.invalid'
             AND display_name = 'Second Approver'
             THEN 'demo_provision_second_approver'
           WHEN lower(email) LIKE '%@brain.invalid'
             THEN 'other_brain_invalid'
           WHEN lower(email) LIKE '%@brain.fi'
             THEN 'brain_internal'
           WHEN lower(split_part(email, '@', 1)) ~ '(acceptance|rfc[0-9]+|test|qa|demo|seed|sandbox|probe|fixture|automation)'
             THEN 'synthetic_local_part'
           ELSE 'individual_review'
         END AS classification
    FROM non_bootstrap
)
SELECT json_build_object(
  'event', 'commercial_demo_retirement_member_classification',
  'classification', classification,
  'member_count', COUNT(*),
  'tenant_count', COUNT(DISTINCT tenant_id),
  'active_count', COUNT(*) FILTER (WHERE active),
  'matching_user_count', COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1
        FROM users user_row
       WHERE user_row.tenant_id = classified.tenant_id
         AND user_row.id = classified.id
    )
  ),
  'created_within_five_seconds_of_tenant', COUNT(*) FILTER (
    WHERE abs(extract(epoch FROM (created_at - tenant_created_at))) <= 5
  )
)::text
  FROM classified
 GROUP BY classification
 ORDER BY classification;

WITH non_bootstrap AS (
  SELECT member.*
    FROM members member
    JOIN retirement_targets target ON target.tenant_id = member.tenant_id
   WHERE lower(member.email) NOT LIKE 'bootstrap+%@brain.invalid'
)
SELECT json_build_object(
  'event', 'commercial_demo_retirement_member_month',
  'month', to_char(date_trunc('month', created_at), 'YYYY-MM'),
  'member_count', COUNT(*),
  'exact_second_approver_count', COUNT(*) FILTER (
    WHERE lower(email) = 'approver2+' || lower(tenant_id) || '@brain.invalid'
      AND display_name = 'Second Approver'
  )
)::text
  FROM non_bootstrap
 GROUP BY date_trunc('month', created_at)
 ORDER BY date_trunc('month', created_at);

WITH non_bootstrap AS (
  SELECT member.*
    FROM members member
    JOIN retirement_targets target ON target.tenant_id = member.tenant_id
   WHERE lower(member.email) NOT LIKE 'bootstrap+%@brain.invalid'
)
SELECT json_build_object(
  'event', 'commercial_demo_retirement_member_provenance',
  'total', COUNT(*),
  'exact_second_approver_email', COUNT(*) FILTER (
    WHERE lower(email) = 'approver2+' || lower(tenant_id) || '@brain.invalid'
  ),
  'second_approver_display_name', COUNT(*) FILTER (WHERE display_name = 'Second Approver'),
  'admin_role', COUNT(*) FILTER (WHERE role = 'admin'),
  'active', COUNT(*) FILTER (WHERE active),
  'public_email_domain', COUNT(*) FILTER (
    WHERE split_part(lower(email), '@', 2) IN (
      'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
      'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com'
    )
  ),
  'brain_internal_domain', COUNT(*) FILTER (WHERE lower(email) LIKE '%@brain.fi'),
  'brain_invalid_domain', COUNT(*) FILTER (WHERE lower(email) LIKE '%@brain.invalid'),
  'distinct_domains', COUNT(DISTINCT split_part(lower(email), '@', 2))
)::text
  FROM non_bootstrap;

WITH anomalies AS (
  SELECT member.*,
         split_part(lower(member.email), '@', 1) AS local_part,
         split_part(lower(member.email), '@', 2) AS email_domain
    FROM members member
    JOIN retirement_targets target ON target.tenant_id = member.tenant_id
   WHERE lower(member.email) NOT LIKE 'bootstrap+%@brain.invalid'
     AND NOT (
       lower(member.email) = 'approver2+' || lower(member.tenant_id) || '@brain.invalid'
       AND member.display_name = 'Second Approver'
     )
)
SELECT json_build_object(
  'event', 'commercial_demo_retirement_member_anomaly',
  'tenant_id', anomaly.tenant_id,
  'member_id', anomaly.id,
  'masked_email', left(anomaly.local_part, 2) || repeat('*', greatest(length(anomaly.local_part) - 4, 1)) || right(anomaly.local_part, 2) || '@' || anomaly.email_domain,
  'email_domain', anomaly.email_domain,
  'local_part_length', length(anomaly.local_part),
  'local_part_synthetic_marker', anomaly.local_part ~ '(acceptance|rfc[0-9]+|test|qa|demo|seed|sandbox|probe|fixture|automation|approver|cfo)',
  'display_name_synthetic_marker', lower(anomaly.display_name) ~ '(acceptance|rfc[0-9]+|test|qa|demo|seed|sandbox|probe|fixture|automation|approver|cfo)',
  'role', anomaly.role,
  'active', anomaly.active,
  'created_at', anomaly.created_at,
  'matching_user', EXISTS (
    SELECT 1 FROM users user_row WHERE user_row.tenant_id = anomaly.tenant_id AND user_row.id = anomaly.id
  ),
  'member_invite_rows', (
    SELECT COUNT(*) FROM member_invites invite WHERE invite.tenant_id = anomaly.tenant_id AND invite.member_id = anomaly.id
  ),
  'member_changed_audit_rows', (
    SELECT COUNT(*)
      FROM audit_events event
     WHERE event.tenant_id = anomaly.tenant_id
       AND event.action = 'member.changed'
       AND event.outputs #>> '{after,id}' = anomaly.id
  ),
  'member_invited_audit_rows', (
    SELECT COUNT(*)
      FROM audit_events event
     WHERE event.tenant_id = anomaly.tenant_id
       AND event.action = 'member.invited'
       AND event.inputs ->> 'member_id' = anomaly.id
  )
)::text
  FROM anomalies anomaly
 ORDER BY anomaly.tenant_id, anomaly.id;

WITH anomaly_members AS (
  SELECT member.tenant_id, member.id
    FROM members member
    JOIN retirement_targets target ON target.tenant_id = member.tenant_id
   WHERE lower(member.email) NOT LIKE 'bootstrap+%@brain.invalid'
     AND NOT (
       lower(member.email) = 'approver2+' || lower(member.tenant_id) || '@brain.invalid'
       AND member.display_name = 'Second Approver'
     )
)
SELECT json_build_object(
  'event', 'commercial_demo_retirement_member_anomaly_audit',
  'tenant_id', anomaly.tenant_id,
  'member_id', anomaly.id,
  'audit_event_id', event.id,
  'actor', event.actor,
  'action', event.action,
  'mutation', event.inputs ->> 'mutation',
  'after_role', event.outputs #>> '{after,role}',
  'after_status', event.outputs #>> '{after,status}',
  'after_active', event.outputs #>> '{after,active}',
  'created_at', event.created_at
)::text
  FROM anomaly_members anomaly
  JOIN audit_events event
    ON event.tenant_id = anomaly.tenant_id
   AND event.action = 'member.changed'
   AND event.outputs #>> '{after,id}' = anomaly.id
 ORDER BY anomaly.tenant_id, event.created_at, event.id;

WITH anomaly_tenants AS (
  SELECT DISTINCT member.tenant_id
    FROM members member
    JOIN retirement_targets target ON target.tenant_id = member.tenant_id
   WHERE lower(member.email) NOT LIKE 'bootstrap+%@brain.invalid'
     AND NOT (
       lower(member.email) = 'approver2+' || lower(member.tenant_id) || '@brain.invalid'
       AND member.display_name = 'Second Approver'
     )
)
SELECT json_build_object(
  'event', 'commercial_demo_retirement_member_anomaly_tenant_action',
  'tenant_id', anomaly.tenant_id,
  'action', event.action,
  'event_count', COUNT(*),
  'first_at', MIN(event.created_at),
  'last_at', MAX(event.created_at)
)::text
  FROM anomaly_tenants anomaly
  JOIN audit_events event ON event.tenant_id = anomaly.tenant_id
 GROUP BY anomaly.tenant_id, event.action
 ORDER BY anomaly.tenant_id, event.action;
SQL
REMOTE
