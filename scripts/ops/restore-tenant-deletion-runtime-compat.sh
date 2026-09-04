#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_CONFIRMATION="RESTORE_TENANT_DELETION_RUNTIME_COMPAT"

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

docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
REVOKE SELECT ON audit_integrity_findings FROM brain_tenant_deletion;
DO $$
DECLARE
  findings_privileges BOOLEAN;
  checkpoint_privileges BOOLEAN;
BEGIN
  SELECT bool_or(has_table_privilege(
    'brain_tenant_deletion',
    'audit_integrity_findings',
    privilege
  ))
    INTO findings_privileges
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege;

  SELECT bool_or(has_table_privilege(
    'brain_tenant_deletion',
    'audit_verifier_checkpoint',
    privilege
  ))
    INTO checkpoint_privileges
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege;

  IF findings_privileges OR checkpoint_privileges THEN
    RAISE EXCEPTION 'tenant-deletion forensic privileges remain after compatibility restore';
  END IF;
END
$$;
SELECT json_build_object(
  'event', 'tenant_deletion_runtime_compat_restored',
  'findings_access', false,
  'checkpoint_access', false
)::text;
COMMIT;
SQL

for container in brain-prod-worker brain-prod-agents; do
  docker restart "$container" >/dev/null
done

for container in brain-prod-worker brain-prod-agents; do
  deadline=$((SECONDS + 180))
  while (( SECONDS < deadline )); do
    running="$(docker inspect --format='{{.State.Running}}' "$container")"
    healthy="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [[ "$running" == "true" && "$healthy" == "healthy" ]]; then
      break
    fi
    sleep 5
  done

  running="$(docker inspect --format='{{.State.Running}}' "$container")"
  healthy="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
  if [[ "$running" != "true" || "$healthy" != "healthy" ]]; then
    echo "$container did not recover"
    docker logs --tail 80 "$container" >&2 || true
    exit 1
  fi
  echo "${container}_healthy"
done
REMOTE
