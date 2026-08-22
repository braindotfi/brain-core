#!/usr/bin/env bash
set -euo pipefail

: "${BRAIN_TENANT_ID:?BRAIN_TENANT_ID is required}"
if [[ ! "$BRAIN_TENANT_ID" =~ ^tnt_[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
  echo "northstar_production_evals_failed=invalid_tenant_id" >&2
  exit 1
fi

readonly script_path="/tmp/run-northstar-production-assistant-evals.mjs"
readonly eval_path="/tmp/BRAIN_ASSISTANT_DEMO_EVALS.md"

cleanup() {
  docker exec brain-prod-api rm -f "$script_path" "$eval_path" >/dev/null 2>&1 || true
}
trap cleanup EXIT

bootstrap_external_ref="$({
  docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
    BEGIN TRANSACTION READ ONLY;
    SELECT l.external_ref
      FROM member_identity_links l
      JOIN members m
        ON m.tenant_id = l.tenant_id
       AND m.id = l.member_id
     WHERE l.tenant_id = '$BRAIN_TENANT_ID'
       AND l.surface = 'platform'
       AND m.role = 'admin'
       AND m.status = 'active'
       AND m.active = TRUE;
    COMMIT;"
} | tr -d '\r' | sed '/^$/d')"

if [[ "$(printf '%s\n' "$bootstrap_external_ref" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "northstar_production_evals_failed=bootstrap_admin_identity_not_unique" >&2
  exit 1
fi

docker cp /tmp/run-northstar-production-assistant-evals.mjs "brain-prod-api:$script_path"
docker cp /tmp/BRAIN_ASSISTANT_DEMO_EVALS.md "brain-prod-api:$eval_path"

docker exec \
  -e "BRAIN_TENANT_ID=$BRAIN_TENANT_ID" \
  -e "NORTHSTAR_EVAL_PATH=$eval_path" \
  -e "NORTHSTAR_BOOTSTRAP_EXTERNAL_REF=$bootstrap_external_ref" \
  brain-prod-api node "$script_path"
