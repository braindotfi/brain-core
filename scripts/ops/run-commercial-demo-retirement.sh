#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_CONFIRMATION="DELETE_1519_COMMERCIAL_DEMO_TENANTS"
readonly EXPECTED_SOURCE_SHA256="318e3d485df905a326256e70de360bd1cf769437e1cce084719f12ef66b521e7"
readonly EXPECTED_TARGET_SHA256="bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8"
readonly EXPECTED_TARGET_COUNT=1519
readonly QUIET_WINDOW_SECONDS=120
readonly QUIET_POLL_SECONDS=15
readonly QUIET_TIMEOUT_SECONDS=900
readonly REMOTE_REPORT_DIR="/tmp/commercial-demo-retirement-execution"

if [[ "${CONFIRMATION:-}" != "$EXPECTED_CONFIRMATION" ]]; then
  echo "confirmation must equal $EXPECTED_CONFIRMATION"
  exit 1
fi
if [[ -z "${VM_HOST:-}" || -z "${VM_SSH_KEY:-}" ]]; then
  echo "VM_HOST and VM_SSH_KEY must be configured by the production workflow"
  exit 1
fi

actual_source_sha256="$(sha256sum scripts/ops/commercial-name-exceptions-2026-09-03.csv | cut -d ' ' -f 1)"
if [[ "$actual_source_sha256" != "$EXPECTED_SOURCE_SHA256" ]]; then
  echo "fixed source cohort checksum mismatch"
  exit 1
fi

scp -i ~/.ssh/id_deploy \
  scripts/ops/commercial-name-exceptions-2026-09-03.csv \
  scripts/ops/report-commercial-demo-retirement-dry-run.sql \
  scripts/ops/execute-commercial-demo-retirement.mjs \
  "azureuser@$VM_HOST:/tmp/"

ssh -i ~/.ssh/id_deploy -o ServerAliveInterval=30 "azureuser@$VM_HOST" \
  "CONFIRMATION='$CONFIRMATION' bash -s" <<'REMOTE'
set -euo pipefail

readonly EXPECTED_CONFIRMATION="DELETE_1519_COMMERCIAL_DEMO_TENANTS"
readonly EXPECTED_TARGET_SHA256="bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8"
readonly EXPECTED_TARGET_COUNT=1519
readonly QUIET_WINDOW_SECONDS=120
readonly QUIET_POLL_SECONDS=15
readonly QUIET_TIMEOUT_SECONDS=900
readonly REPORT_DIR="/tmp/commercial-demo-retirement-execution"
readonly PROTECTED_TENANTS=(
  tnt_00000000010000000000000000
  tnt_01KYAT7A1QRKHTYW9H4RAR2SEX
  tnt_01KYAT31JH0G043K77H8SKYG4N
  tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ
  tnt_01M1GTBQN8R8PB6X6PN73YB6NP
  tnt_01M1M64ZE1R8J9TB6C3DCRKA61
)

if [[ "$CONFIRMATION" != "$EXPECTED_CONFIRMATION" ]]; then
  echo "remote confirmation failed"
  exit 1
fi

mkdir -p "$REPORT_DIR"
chmod 700 "$REPORT_DIR"
rm -f "$REPORT_DIR"/*

worker_was_running=false
agents_were_running=false
deletion_committed=false
agent_state_snapshot="/tmp/commercial-demo-retirement-agent-states.csv"
rm -f "$agent_state_snapshot"

container_is_running() {
  [[ "$(docker inspect --format='{{.State.Running}}' "$1" 2>/dev/null || true)" == "true" ]]
}

container_is_healthy() {
  [[ "$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true)" == "healthy" ]]
}

wait_for_healthy() {
  local container="$1"
  local attempts=0
  until container_is_healthy "$container"; do
    attempts=$((attempts + 1))
    if (( attempts >= 36 )); then
      echo "$container did not become healthy"
      docker logs --tail=200 "$container" >&2 || true
      return 1
    fi
    sleep 5
  done
}

restart_fenced_containers() {
  local status=0
  if [[ "$worker_was_running" == "true" ]] && ! container_is_running brain-prod-worker; then
    docker start brain-prod-worker >/dev/null || status=1
  fi
  if [[ "$agents_were_running" == "true" ]] && ! container_is_running brain-prod-agents; then
    docker start brain-prod-agents >/dev/null || status=1
  fi
  if [[ "$worker_was_running" == "true" ]]; then
    wait_for_healthy brain-prod-worker || status=1
  fi
  if [[ "$agents_were_running" == "true" ]]; then
    wait_for_healthy brain-prod-agents || status=1
  fi
  return "$status"
}

run_complete_rehearsal() {
  local log_file="$1"
  docker cp /tmp/commercial-name-exceptions-2026-09-03.csv \
    brain-prod-postgres:/tmp/commercial-name-exceptions.csv
  docker exec -i brain-prod-postgres psql -U brain -d brain \
    -f /dev/stdin \
    < /tmp/report-commercial-demo-retirement-dry-run.sql \
    | tee "$log_file"
  docker cp brain-prod-postgres:/tmp/commercial-demo-retirement-targets.csv \
    /tmp/commercial-demo-retirement-targets.csv
}

validate_target_file() {
  local actual_target_sha256 target_count tenant_id
  actual_target_sha256="$(sha256sum /tmp/commercial-demo-retirement-targets.csv | cut -d ' ' -f 1)"
  if [[ "$actual_target_sha256" != "$EXPECTED_TARGET_SHA256" ]]; then
    echo "candidate-list hash mismatch: $actual_target_sha256"
    return 1
  fi
  target_count="$(tail -n +2 /tmp/commercial-demo-retirement-targets.csv | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$target_count" != "$EXPECTED_TARGET_COUNT" ]]; then
    echo "candidate-list count mismatch: $target_count"
    return 1
  fi
  for tenant_id in "${PROTECTED_TENANTS[@]}"; do
    if grep -Fqx "$tenant_id" /tmp/commercial-demo-retirement-targets.csv; then
      echo "protected tenant reached target list: $tenant_id"
      return 1
    fi
  done
}

candidate_activity_count_since() {
  local activity_since="$1"
  docker exec -i brain-prod-postgres psql -U brain -d brain -qAt -v ON_ERROR_STOP=1 \
    -v activity_since="$activity_since" <<'SQL' | tail -n 1
CREATE TEMP TABLE activity_targets (tenant_id TEXT PRIMARY KEY);
\copy activity_targets FROM '/tmp/commercial-demo-retirement-targets.csv' WITH (FORMAT csv, HEADER true)
SELECT (
  (SELECT COUNT(*) FROM audit_events event JOIN activity_targets target ON target.tenant_id = event.tenant_id WHERE event.created_at >= :'activity_since'::timestamptz) +
  (SELECT COUNT(*) FROM agent_runs run JOIN activity_targets target ON target.tenant_id = run.tenant_id WHERE run.created_at >= :'activity_since'::timestamptz) +
  (SELECT COUNT(*) FROM proposals proposal JOIN activity_targets target ON target.tenant_id = proposal.tenant_id WHERE proposal.created_at >= :'activity_since'::timestamptz) +
  (SELECT COUNT(*) FROM raw_artifacts artifact JOIN activity_targets target ON target.tenant_id = artifact.tenant_id WHERE artifact.ingested_at >= :'activity_since'::timestamptz) +
  (SELECT COUNT(*) FROM raw_sources source JOIN activity_targets target ON target.tenant_id = source.tenant_id WHERE source.created_at >= :'activity_since'::timestamptz) +
  (SELECT COUNT(*) FROM execution_outbox outbox JOIN activity_targets target ON target.tenant_id = outbox.tenant_id WHERE outbox.created_at >= :'activity_since'::timestamptz OR outbox.status IN ('dispatching', 'reconciling'))
)::bigint;
SQL
}

wait_for_candidate_quiescence() {
  local started_epoch deadline_epoch quiet_since quiet_since_epoch now_epoch quiet_seconds activity_count
  started_epoch="$(date -u +%s)"
  deadline_epoch=$((started_epoch + QUIET_TIMEOUT_SECONDS))
  quiet_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  quiet_since_epoch="$started_epoch"

  while true; do
    sleep "$QUIET_POLL_SECONDS"
    activity_count="$(candidate_activity_count_since "$quiet_since")"
    if [[ ! "$activity_count" =~ ^[0-9]+$ ]]; then
      echo "candidate quiescence query returned an invalid count" >&2
      return 1
    fi

    now_epoch="$(date -u +%s)"
    if (( activity_count > 0 )); then
      printf '{"event":"commercial_demo_retirement_quiet_window_reset","activity_count":%s,"observed_at":"%s"}\n' \
        "$activity_count" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
      quiet_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      quiet_since_epoch="$now_epoch"
    else
      quiet_seconds=$((now_epoch - quiet_since_epoch))
      printf '{"event":"commercial_demo_retirement_quiet_window_observation","quiet_seconds":%s,"required_seconds":%s}\n' \
        "$quiet_seconds" "$QUIET_WINDOW_SECONDS" >&2
      if (( quiet_seconds >= QUIET_WINDOW_SECONDS )); then
        printf '%s\n' "$quiet_since"
        return 0
      fi
    fi

    if (( now_epoch >= deadline_epoch )); then
      echo "candidate activity did not quiesce within $QUIET_TIMEOUT_SECONDS seconds" >&2
      return 1
    fi
  done
}

restore_agent_states_after_abort() {
  if [[ "$deletion_committed" == "true" || ! -s "$agent_state_snapshot" ]]; then
    return 0
  fi
  docker cp "$agent_state_snapshot" brain-prod-postgres:/tmp/commercial-demo-retirement-agent-states.csv
  docker exec -i brain-prod-postgres psql -U brain -d brain -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
CREATE TEMP TABLE restore_agent_states (
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (tenant_id, agent_id)
);
\copy restore_agent_states FROM '/tmp/commercial-demo-retirement-agent-states.csv' WITH (FORMAT csv, HEADER true)
UPDATE agents agent
   SET state = restore.state
  FROM restore_agent_states restore
 WHERE agent.tenant_id = restore.tenant_id
   AND agent.id = restore.agent_id;
COMMIT;
SQL
}

on_exit() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    restore_agent_states_after_abort || true
  fi
  restart_fenced_containers || exit_code=1
  exit "$exit_code"
}
trap on_exit EXIT

if ! container_is_healthy brain-prod-worker; then
  echo "brain-prod-worker was not healthy before the fence"
  exit 1
fi
worker_was_running=true
if ! container_is_healthy brain-prod-agents; then
  echo "brain-prod-agents was not healthy before the fence"
  exit 1
fi
agents_were_running=true

docker stop -t 30 brain-prod-agents brain-prod-worker >/dev/null
if container_is_running brain-prod-agents || container_is_running brain-prod-worker; then
  echo "activity fence failed to stop a worker container"
  exit 1
fi
run_complete_rehearsal "$REPORT_DIR/pre-fence-cohort.log"
validate_target_file

fence_started_at="$(wait_for_candidate_quiescence)"
printf '%s\n' "$fence_started_at" > "$REPORT_DIR/fence-started-at.txt"
run_complete_rehearsal "$REPORT_DIR/final-preflight.log"
validate_target_file

printf '%s  %s\n' "$EXPECTED_TARGET_SHA256" commercial-demo-retirement-targets.csv \
  > "$REPORT_DIR/candidate-list-SHA256SUMS"
cp /tmp/commercial-demo-retirement-targets.csv "$REPORT_DIR/"

docker exec -i brain-prod-postgres psql -U brain -d brain -At -F ',' -v ON_ERROR_STOP=1 <<'SQL' \
  > "$agent_state_snapshot"
SELECT 'tenant_id,agent_id,state'
UNION ALL
SELECT agent.tenant_id || ',' || agent.id || ',' || agent.state
  FROM agents agent
  JOIN (
    SELECT trim(line) AS tenant_id
      FROM regexp_split_to_table(pg_read_file('/tmp/commercial-demo-retirement-targets.csv'), E'\n') line
     WHERE trim(line) LIKE 'tnt_%'
  ) target ON target.tenant_id = agent.tenant_id
 ORDER BY 1;
SQL

docker exec -i brain-prod-postgres psql -U brain -d brain -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
CREATE TEMP TABLE retirement_targets (tenant_id TEXT PRIMARY KEY);
\copy retirement_targets FROM '/tmp/commercial-demo-retirement-targets.csv' WITH (FORMAT csv, HEADER true)
UPDATE agents agent
   SET state = 'quarantined'
  FROM retirement_targets target
 WHERE agent.tenant_id = target.tenant_id
   AND agent.state <> 'quarantined';
COMMIT;
SQL

docker cp /tmp/commercial-demo-retirement-targets.csv \
  brain-prod-api:/tmp/commercial-demo-retirement-targets.csv
docker cp /tmp/execute-commercial-demo-retirement.mjs \
  brain-prod-api:/app/scripts/ops/execute-commercial-demo-retirement.mjs
docker exec \
  -e FENCE_STARTED_AT="$fence_started_at" \
  brain-prod-api \
  node /app/scripts/ops/execute-commercial-demo-retirement.mjs \
  | tee "$REPORT_DIR/database-execution.jsonl"
deletion_committed=true

read -r expected_blob_jobs expected_blob_artifacts < <(
  docker exec -i brain-prod-api node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const lines = input.trim().split("\n");
      const value = JSON.parse(lines.at(-1));
      process.stdout.write(`${value.blob_purge_jobs_enqueued} ${value.blob_artifact_rows}`);
    });
  ' < "$REPORT_DIR/database-execution.jsonl"
)

restart_fenced_containers

reconciliation_complete=false
for attempt in $(seq 1 180); do
  reconciliation="$({
    docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE retirement_targets (tenant_id TEXT PRIMARY KEY);
\copy retirement_targets FROM '/tmp/commercial-demo-retirement-targets.csv' WITH (FORMAT csv, HEADER true)
SELECT json_build_object(
  'remaining_tenants', (
    SELECT COUNT(*) FROM tenants tenant JOIN retirement_targets target ON target.tenant_id = tenant.id
  ),
  'blob_jobs', (
    SELECT COUNT(*) FROM tenant_blob_purge_jobs job JOIN retirement_targets target ON target.tenant_id = job.tenant_id
  ),
  'blob_jobs_completed', (
    SELECT COUNT(*) FROM tenant_blob_purge_jobs job JOIN retirement_targets target ON target.tenant_id = job.tenant_id WHERE job.status = 'completed'
  ),
  'blob_jobs_non_completed', (
    SELECT COUNT(*) FROM tenant_blob_purge_jobs job JOIN retirement_targets target ON target.tenant_id = job.tenant_id WHERE job.status <> 'completed'
  ),
  'blob_artifact_rows', (
    SELECT COALESCE(SUM(job.blob_artifact_count), 0) FROM tenant_blob_purge_jobs job JOIN retirement_targets target ON target.tenant_id = job.tenant_id
  ),
  'blob_objects_deleted', (
    SELECT COALESCE(SUM(job.deleted_count), 0) FROM tenant_blob_purge_jobs job JOIN retirement_targets target ON target.tenant_id = job.tenant_id
  ),
  'outbox_rows', (
    SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id
  ),
  'outbox_pending', (
    SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id WHERE outbox.status <> 'published'
  ),
  'tenant_deleted_published', (
    SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id WHERE outbox.action = 'tenant.deleted' AND outbox.status = 'published'
  ),
  'purge_requested_published', (
    SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id WHERE outbox.action = 'tenant_blob.purge_requested' AND outbox.status = 'published'
  ),
  'purge_completed_published', (
    SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id WHERE outbox.action = 'tenant_blob.purge_completed' AND outbox.status = 'published'
  )
)::text;
SQL
  } | tail -n 1)"
  printf '%s\n' "$reconciliation" > "$REPORT_DIR/post-deletion-reconciliation.json"
  if printf '%s' "$reconciliation" | docker exec \
    -i \
    -e EXPECTED_BLOB_JOBS="$expected_blob_jobs" \
    -e EXPECTED_BLOB_ARTIFACTS="$expected_blob_artifacts" \
    brain-prod-api node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const expectedBlobJobs = Number(process.env.EXPECTED_BLOB_JOBS);
      const expectedBlobArtifacts = Number(process.env.EXPECTED_BLOB_ARTIFACTS);
      const okay = value.remaining_tenants === 0 &&
        value.blob_jobs === expectedBlobJobs &&
        value.blob_jobs_completed === expectedBlobJobs &&
        value.blob_jobs_non_completed === 0 &&
        value.blob_artifact_rows === expectedBlobArtifacts &&
        value.outbox_pending === 0 &&
        value.tenant_deleted_published === 1519 &&
        value.purge_requested_published === expectedBlobJobs &&
        value.purge_completed_published === expectedBlobJobs;
      process.exit(okay ? 0 : 1);
    });
  '; then
    reconciliation_complete=true
    break
  fi
  sleep 15
done
if [[ "$reconciliation_complete" != "true" ]]; then
  echo "post-deletion purge or audit reconciliation did not complete"
  cat "$REPORT_DIR/post-deletion-reconciliation.json"
  exit 1
fi

docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 <<'SQL' \
  > "$REPORT_DIR/preserved-evidence-counts.json"
CREATE TEMP TABLE retirement_targets (tenant_id TEXT PRIMARY KEY);
\copy retirement_targets FROM '/tmp/commercial-demo-retirement-targets.csv' WITH (FORMAT csv, HEADER true)
SELECT json_build_object(
  'audit_events', (SELECT COUNT(*) FROM audit_events row JOIN retirement_targets target ON target.tenant_id = row.tenant_id),
  'audit_anchors', (SELECT COUNT(*) FROM audit_anchors row JOIN retirement_targets target ON target.tenant_id = row.tenant_id),
  'audit_integrity_findings', (SELECT COUNT(*) FROM audit_integrity_findings row JOIN retirement_targets target ON target.tenant_id = row.tenant_id),
  'tenant_blob_purge_jobs', (SELECT COUNT(*) FROM tenant_blob_purge_jobs row JOIN retirement_targets target ON target.tenant_id = row.tenant_id),
  'tenant_blob_purge_audit_outbox', (SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox row JOIN retirement_targets target ON target.tenant_id = row.tenant_id)
)::text;
SQL

{
  printf '{"brain_prod_worker":{"state":"%s","health":"%s"},' \
    "$(docker inspect --format='{{.State.Status}}' brain-prod-worker)" \
    "$(docker inspect --format='{{.State.Health.Status}}' brain-prod-worker)"
  printf '"brain_prod_agents":{"state":"%s","health":"%s"}}\n' \
    "$(docker inspect --format='{{.State.Status}}' brain-prod-agents)" \
    "$(docker inspect --format='{{.State.Health.Status}}' brain-prod-agents)"
} > "$REPORT_DIR/worker-restart-status.json"

(cd "$REPORT_DIR" && sha256sum ./* > report-SHA256SUMS)
printf '%s\n' "commercial_demo_retirement_complete" > "$REPORT_DIR/COMPLETE"
REMOTE

rm -rf commercial-demo-retirement-execution
mkdir -p commercial-demo-retirement-execution
scp -i ~/.ssh/id_deploy \
  "azureuser@$VM_HOST:$REMOTE_REPORT_DIR/*" \
  commercial-demo-retirement-execution/
(
  cd commercial-demo-retirement-execution
  sha256sum --check report-SHA256SUMS
)
