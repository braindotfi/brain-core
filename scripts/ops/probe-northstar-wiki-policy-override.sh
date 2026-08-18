#!/usr/bin/env bash
set -euo pipefail

readonly tenant_id="tnt_01M08J9B75QH08MCVA884N57VB"
readonly script_path="/tmp/probe-northstar-wiki-policy-override.mjs"

cleanup() {
  docker exec brain-prod-api rm -f "$script_path" >/dev/null 2>&1 || true
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
     WHERE l.tenant_id = '$tenant_id'
       AND l.surface = 'platform'
       AND m.role = 'admin'
       AND m.status = 'active'
       AND m.active = TRUE
     ORDER BY l.linked_at ASC
     LIMIT 1;
    COMMIT;"
} | tr -d '\r' | sed '/^$/d')"

if [[ "$(printf '%s\n' "$bootstrap_external_ref" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "northstar_wiki_policy_override_probe_failed=bootstrap_admin_identity_not_unique" >&2
  exit 1
fi

docker cp /tmp/probe-northstar-wiki-policy-override.mjs "brain-prod-api:$script_path"
docker exec \
  -e "NORTHSTAR_BOOTSTRAP_EXTERNAL_REF=$bootstrap_external_ref" \
  brain-prod-api node "$script_path"
