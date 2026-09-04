#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_SOURCE_SHA256="318e3d485df905a326256e70de360bd1cf769437e1cce084719f12ef66b521e7"
readonly EXPECTED_TARGET_SHA256="bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8"
readonly EXPECTED_TARGET_COUNT=1519
readonly REPORT_DIR="commercial-demo-retirement-phase-a"
readonly REMOTE_ROOT="/tmp/commercial-demo-retirement-phase-a-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}"

if [[ ! "${EXPECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected_sha must be a full lowercase commit SHA"
  exit 1
fi
if [[ -z "${VM_HOST:-}" || -z "${VM_SSH_KEY:-}" ]]; then
  echo "production VM connection is unavailable"
  exit 1
fi

actual_source_sha256="$(sha256sum scripts/ops/commercial-name-exceptions-2026-09-03.csv | cut -d ' ' -f 1)"
if [[ "$actual_source_sha256" != "$EXPECTED_SOURCE_SHA256" ]]; then
  echo "fixed source cohort checksum mismatch"
  exit 1
fi

mkdir -p "$REPORT_DIR"
rm -f "$REPORT_DIR"/*

ssh -i ~/.ssh/id_deploy "azureuser@$VM_HOST" "mkdir -p '$REMOTE_ROOT' && chmod 700 '$REMOTE_ROOT'"
scp -i ~/.ssh/id_deploy \
  scripts/ops/commercial-name-exceptions-2026-09-03.csv \
  scripts/ops/check-commercial-demo-retirement-host-overlap.sh \
  scripts/ops/check-commercial-demo-retirement-privileges.mjs \
  scripts/ops/report-commercial-demo-retirement-dry-run.sql \
  "azureuser@$VM_HOST:$REMOTE_ROOT/"

set +e
ssh -i ~/.ssh/id_deploy -o ServerAliveInterval=30 "azureuser@$VM_HOST" \
  "EXPECTED_SHA='$EXPECTED_SHA' REMOTE_ROOT='$REMOTE_ROOT' bash -s" <<'REMOTE'
set -euo pipefail

readonly EXPECTED_TARGET_SHA256="bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8"
readonly EXPECTED_TARGET_COUNT=1519
readonly QUIET_WINDOW_SECONDS=120
readonly QUIET_POLL_SECONDS=15
readonly QUIET_TIMEOUT_SECONDS=900
readonly REPORT_DIR="$REMOTE_ROOT/report"
readonly PROTECTED_TENANTS=(
  tnt_00000000010000000000000000
  tnt_01KYAT7A1QRKHTYW9H4RAR2SEX
  tnt_01KYAT31JH0G043K77H8SKYG4N
  tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ
  tnt_01M1GTBQN8R8PB6X6PN73YB6NP
  tnt_01M1M64ZE1R8J9TB6C3DCRKA61
)

mkdir -p "$REPORT_DIR"
chmod 700 "$REPORT_DIR"
rm -f "$REPORT_DIR"/*

worker_was_running=false
agents_were_running=false

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
      return 1
    fi
    sleep 5
  done
}

restore_fenced_containers() {
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

on_exit() {
  local exit_code=$?
  restore_fenced_containers || exit_code=1
  {
    printf '{"container":"brain-prod-worker","state":"%s","health":"%s","restart_count":%s}\n' \
      "$(docker inspect --format='{{.State.Status}}' brain-prod-worker)" \
      "$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' brain-prod-worker)" \
      "$(docker inspect --format='{{.RestartCount}}' brain-prod-worker)"
    printf '{"container":"brain-prod-agents","state":"%s","health":"%s","restart_count":%s}\n' \
      "$(docker inspect --format='{{.State.Status}}' brain-prod-agents)" \
      "$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' brain-prod-agents)" \
      "$(docker inspect --format='{{.RestartCount}}' brain-prod-agents)"
  } > "$REPORT_DIR/restored-container-status.jsonl" 2>/dev/null || true
  exit "$exit_code"
}
trap on_exit EXIT

clear_rehearsal_outputs() {
  docker exec -u 0 brain-prod-postgres rm -f \
    /tmp/commercial-demo-retirement-targets.csv \
    /tmp/commercial-demo-retirement-exclusions.csv \
    /tmp/commercial-demo-retirement-self-serve-evidence.csv \
    /tmp/commercial-demo-retirement-per-tenant-effects.csv \
    /tmp/commercial-demo-retirement-per-table-effects.csv \
    /tmp/commercial-demo-retirement-blob-manifest.csv \
    /tmp/commercial-demo-retirement-september-safety.csv
}

run_complete_rehearsal() {
  local log_file="$1"
  clear_rehearsal_outputs
  docker cp "$REMOTE_ROOT/commercial-name-exceptions-2026-09-03.csv" \
    brain-prod-postgres:/tmp/commercial-name-exceptions.csv
  docker exec -i brain-prod-postgres psql -U brain -d brain \
    -f /dev/stdin \
    < "$REMOTE_ROOT/report-commercial-demo-retirement-dry-run.sql" \
    | tee "$log_file"
  docker cp brain-prod-postgres:/tmp/commercial-demo-retirement-targets.csv \
    "$REPORT_DIR/commercial-demo-retirement-targets.csv"
  docker cp brain-prod-postgres:/tmp/commercial-demo-retirement-per-table-effects.csv \
    "$REPORT_DIR/commercial-demo-retirement-per-table-effects.csv"
}

validate_target_file() {
  local target_file="$REPORT_DIR/commercial-demo-retirement-targets.csv"
  local actual_target_sha256 target_count tenant_id
  actual_target_sha256="$(sha256sum "$target_file" | cut -d ' ' -f 1)"
  target_count="$(tail -n +2 "$target_file" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$actual_target_sha256" != "$EXPECTED_TARGET_SHA256" ]]; then
    echo "candidate-list hash mismatch: $actual_target_sha256"
    return 1
  fi
  if [[ "$target_count" != "$EXPECTED_TARGET_COUNT" ]]; then
    echo "candidate-list count mismatch: $target_count"
    return 1
  fi
  : > "$REPORT_DIR/protected-tenant-checks.txt"
  for tenant_id in "${PROTECTED_TENANTS[@]}"; do
    if grep -Fqx "$tenant_id" "$target_file"; then
      echo "protected tenant reached target list: $tenant_id"
      return 1
    fi
    printf '%s absent\n' "$tenant_id" >> "$REPORT_DIR/protected-tenant-checks.txt"
  done
  printf '%s  commercial-demo-retirement-targets.csv\n' "$actual_target_sha256" \
    > "$REPORT_DIR/candidate-list-SHA256SUMS"
  printf 'candidate_count=%s\ncandidate_hash=%s\n' "$target_count" "$actual_target_sha256" \
    > "$REPORT_DIR/candidate-summary.txt"
}

candidate_activity_count_since() {
  local activity_since="$1"
  docker cp "$REPORT_DIR/commercial-demo-retirement-targets.csv" \
    brain-prod-postgres:/tmp/commercial-demo-retirement-targets.csv
  docker exec -i \
    -e PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=1000' \
    brain-prod-postgres psql -U brain -d brain -qAt -v ON_ERROR_STOP=1 \
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
    if container_is_running brain-prod-agents || container_is_running brain-prod-worker; then
      echo "activity fence released during quiescence"
      return 1
    fi
    activity_count="$(candidate_activity_count_since "$quiet_since")"
    if [[ ! "$activity_count" =~ ^[0-9]+$ ]]; then
      echo "candidate quiescence query returned an invalid count"
      return 1
    fi
    now_epoch="$(date -u +%s)"
    if (( activity_count > 0 )); then
      printf '{"event":"quiet_window_reset","activity_count":%s,"observed_at":"%s"}\n' \
        "$activity_count" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$REPORT_DIR/quiescence.jsonl"
      quiet_since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      quiet_since_epoch="$now_epoch"
    else
      quiet_seconds=$((now_epoch - quiet_since_epoch))
      printf '{"event":"quiet_window_observation","quiet_seconds":%s,"required_seconds":%s}\n' \
        "$quiet_seconds" "$QUIET_WINDOW_SECONDS" | tee -a "$REPORT_DIR/quiescence.jsonl"
      if (( quiet_seconds >= QUIET_WINDOW_SECONDS )); then
        printf '%s\n' "$quiet_since"
        return 0
      fi
    fi
    if (( now_epoch >= deadline_epoch )); then
      echo "candidate activity did not quiesce within $QUIET_TIMEOUT_SECONDS seconds"
      return 1
    fi
  done
}

api_sha="$(docker exec brain-prod-api printenv GIT_SHA)"
worker_sha="$(docker exec brain-prod-worker printenv GIT_SHA)"
printf 'api_git_sha=%s\nworker_git_sha=%s\n' "$api_sha" "$worker_sha" \
  | tee "$REPORT_DIR/runtime-sha.txt"
[[ "$api_sha" == "$EXPECTED_SHA" ]]
[[ "$worker_sha" == "$EXPECTED_SHA" ]]

container_is_healthy brain-prod-worker
worker_was_running=true
container_is_healthy brain-prod-agents
agents_were_running=true

docker stop -t 30 brain-prod-agents brain-prod-worker >/dev/null
if container_is_running brain-prod-agents || container_is_running brain-prod-worker; then
  echo "activity fence failed to stop worker containers"
  exit 1
fi
fence_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'fence_started_at=%s\nworker_stopped=true\nagents_stopped=true\n' "$fence_started_at" \
  > "$REPORT_DIR/fence-status.txt"

run_complete_rehearsal "$REPORT_DIR/pre-fence-cohort.log"
validate_target_file

docker cp "$REMOTE_ROOT/check-commercial-demo-retirement-privileges.mjs" \
  brain-prod-api:/app/scripts/ops/check-commercial-demo-retirement-privileges.mjs
docker exec brain-prod-api \
  node /app/scripts/ops/check-commercial-demo-retirement-privileges.mjs \
  | tee "$REPORT_DIR/deletion-role-privileges.jsonl"

{
  crontab -l 2>/dev/null || true
  cat /etc/crontab 2>/dev/null || true
  systemctl list-timers --all --no-pager 2>/dev/null || true
} > "$REPORT_DIR/host-schedules.txt"
bash "$REMOTE_ROOT/check-commercial-demo-retirement-host-overlap.sh" \
  < "$REPORT_DIR/host-schedules.txt"

if pgrep -af '(pg_dump|pg_basebackup|restic|borg|azcopy|mc[[:space:]]+mirror)' \
  > "$REPORT_DIR/active-backup-processes.txt"; then
  echo "active backup or transfer process found"
  exit 1
fi
printf 'none\n' > "$REPORT_DIR/active-backup-processes.txt"

docker exec -i brain-prod-postgres psql -U brain -d brain -AtX -v ON_ERROR_STOP=1 <<'SQL' \
  > "$REPORT_DIR/database-overlap-checks.txt"
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT 'long_transactions=' || COUNT(*)
  FROM pg_stat_activity
 WHERE pid <> pg_backend_pid()
   AND datname = current_database()
   AND xact_start IS NOT NULL
   AND xact_start < now() - interval '30 seconds';
SELECT 'backup_progress=' || COUNT(*) FROM pg_stat_progress_basebackup;
SELECT 'verifier_or_anchor_queries=' || COUNT(*)
  FROM pg_stat_activity
 WHERE pid <> pg_backend_pid()
   AND state <> 'idle'
   AND (
     query ILIKE '%audit_verifier_checkpoint%'
     OR query ILIKE '%audit_anchors%'
     OR query ILIKE '%anchorBatch%'
   );
COMMIT;
SQL
if ! grep -qx 'long_transactions=0' "$REPORT_DIR/database-overlap-checks.txt" \
  || ! grep -qx 'backup_progress=0' "$REPORT_DIR/database-overlap-checks.txt" \
  || ! grep -qx 'verifier_or_anchor_queries=0' "$REPORT_DIR/database-overlap-checks.txt"; then
  echo "database overlap check failed"
  cat "$REPORT_DIR/database-overlap-checks.txt"
  exit 1
fi

quiet_since="$(wait_for_candidate_quiescence | tail -n 1)"
printf 'quiet_since=%s\nquiet_window_seconds=%s\n' "$quiet_since" "$QUIET_WINDOW_SECONDS" \
  >> "$REPORT_DIR/fence-status.txt"

run_complete_rehearsal "$REPORT_DIR/final-preflight.log"
validate_target_file
final_activity_count="$(candidate_activity_count_since "$quiet_since")"
if [[ "$final_activity_count" != "0" ]]; then
  echo "new candidate activity appeared after quiescence: $final_activity_count"
  exit 1
fi
printf 'final_activity_count=0\n' >> "$REPORT_DIR/fence-status.txt"

awk -F, 'BEGIN { OFS="," }
  NR == 1 { print $0,"batch_size","batch_count"; next }
  {
    size = ($1 == "tenants" ? 250 : 10000)
    batches = ($2 == "delete" && $3 > 0 ? int(($3 + size - 1) / size) : 0)
    print $0,size,batches
  }' "$REPORT_DIR/commercial-demo-retirement-per-table-effects.csv" \
  > "$REPORT_DIR/batch-plan.csv"

awk -F, 'NR > 1 && $2 == "delete" { rows += $3; batches += $6 }
  END {
    printf "delete_rows=%d\ndelete_batches=%d\nexpected_transaction_minutes=75-120\ndatabase_watchdog_minutes=180\nworkflow_limit_minutes=210\n", rows, batches
  }' "$REPORT_DIR/batch-plan.csv" > "$REPORT_DIR/batch-summary.txt"

printf 'repository_scheduled_workflows=none\nactive_backup_processes=0\nmanual_database_operations=0\nworker_schedulers_stopped=true\n' \
  > "$REPORT_DIR/overlap-summary.txt"

cat "$REPORT_DIR/candidate-summary.txt"
cat "$REPORT_DIR/protected-tenant-checks.txt"
cat "$REPORT_DIR/fence-status.txt"
cat "$REPORT_DIR/database-overlap-checks.txt"
cat "$REPORT_DIR/overlap-summary.txt"
cat "$REPORT_DIR/batch-summary.txt"
cat "$REPORT_DIR/batch-plan.csv"
REMOTE
remote_status=$?
set -e

scp -i ~/.ssh/id_deploy -r \
  "azureuser@$VM_HOST:$REMOTE_ROOT/report/." "$REPORT_DIR/" || true

exit "$remote_status"
