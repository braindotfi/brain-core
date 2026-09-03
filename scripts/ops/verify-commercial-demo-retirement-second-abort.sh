#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_CONFIRMATION="VERIFY_1519_COMMERCIAL_DEMO_TENANTS_SECOND_ABORT"
readonly EXPECTED_SOURCE_SHA256="318e3d485df905a326256e70de360bd1cf769437e1cce084719f12ef66b521e7"

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
  "azureuser@$VM_HOST:/tmp/commercial-demo-retirement-second-abort-source.csv"

ssh -i ~/.ssh/id_deploy -o ServerAliveInterval=30 "azureuser@$VM_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail

for container in brain-prod-worker brain-prod-agents; do
  running="$(docker inspect --format='{{.State.Running}}' "$container")"
  healthy="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
  if [[ "$running" != "true" || "$healthy" != "healthy" ]]; then
    echo "$container is not running and healthy"
    exit 1
  fi
done

docker cp /tmp/commercial-demo-retirement-second-abort-source.csv \
  brain-prod-postgres:/tmp/commercial-demo-retirement-second-abort-source.csv
docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 <<'SQL'
CREATE TEMP TABLE retirement_source (tenant_id TEXT PRIMARY KEY);
\copy retirement_source FROM '/tmp/commercial-demo-retirement-second-abort-source.csv' WITH (FORMAT csv, HEADER true)
CREATE TEMP TABLE retirement_targets AS
SELECT tenant_id
  FROM retirement_source
 WHERE tenant_id <> 'tnt_00000000010000000000000000';

DO $$
DECLARE
  source_count BIGINT;
  target_count BIGINT;
  remaining_count BIGINT;
  non_demo_count BIGINT;
  protected_overlap BIGINT;
  blob_job_count BIGINT;
  deletion_outbox_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO source_count FROM retirement_source;
  SELECT COUNT(*) INTO target_count FROM retirement_targets;
  SELECT COUNT(*) INTO remaining_count
    FROM tenants tenant JOIN retirement_targets target ON target.tenant_id = tenant.id;
  SELECT COUNT(*) INTO non_demo_count
    FROM tenants tenant JOIN retirement_targets target ON target.tenant_id = tenant.id
   WHERE tenant.kind <> 'demo';
  SELECT COUNT(*) INTO protected_overlap
    FROM retirement_targets
   WHERE tenant_id = ANY(ARRAY[
     'tnt_00000000010000000000000000',
     'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX',
     'tnt_01KYAT31JH0G043K77H8SKYG4N',
     'tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ',
     'tnt_01M1GTBQN8R8PB6X6PN73YB6NP',
     'tnt_01M1M64ZE1R8J9TB6C3DCRKA61'
   ]::text[]);
  SELECT COUNT(*) INTO blob_job_count
    FROM tenant_blob_purge_jobs job
    JOIN retirement_targets target ON target.tenant_id = job.tenant_id;
  SELECT COUNT(*) INTO deletion_outbox_count
    FROM tenant_blob_purge_audit_outbox outbox
    JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id;

  IF source_count <> 1520 OR target_count <> 1519 OR remaining_count <> 1519 OR
     non_demo_count <> 0 OR protected_overlap <> 0 OR blob_job_count <> 0 OR
     deletion_outbox_count <> 0 THEN
    RAISE EXCEPTION 'second abort preservation check failed';
  END IF;
END
$$;

SELECT json_build_object(
  'event', 'commercial_demo_retirement_second_abort_verified',
  'source_count', (SELECT COUNT(*) FROM retirement_source),
  'target_count', (SELECT COUNT(*) FROM retirement_targets),
  'remaining_tenants', (
    SELECT COUNT(*) FROM tenants tenant JOIN retirement_targets target ON target.tenant_id = tenant.id
  ),
  'protected_overlap', (
    SELECT COUNT(*) FROM retirement_targets
     WHERE tenant_id = ANY(ARRAY[
       'tnt_00000000010000000000000000',
       'tnt_01KYAT7A1QRKHTYW9H4RAR2SEX',
       'tnt_01KYAT31JH0G043K77H8SKYG4N',
       'tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ',
       'tnt_01M1GTBQN8R8PB6X6PN73YB6NP',
       'tnt_01M1M64ZE1R8J9TB6C3DCRKA61'
     ]::text[])
  ),
  'blob_purge_jobs', (
    SELECT COUNT(*) FROM tenant_blob_purge_jobs job JOIN retirement_targets target ON target.tenant_id = job.tenant_id
  ),
  'deletion_audit_outbox_rows', (
    SELECT COUNT(*) FROM tenant_blob_purge_audit_outbox outbox JOIN retirement_targets target ON target.tenant_id = outbox.tenant_id
  ),
  'worker_healthy', true,
  'agents_healthy', true
)::text;
SQL
REMOTE
