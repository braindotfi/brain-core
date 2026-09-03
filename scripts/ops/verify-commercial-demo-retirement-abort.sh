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
SQL
REMOTE
