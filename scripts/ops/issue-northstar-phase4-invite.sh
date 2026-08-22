#!/usr/bin/env bash
set -euo pipefail

readonly tenant_id="tnt_01M0DBPNXG0TRB0SV1WTMB6F6J"
readonly script_path="/tmp/issue-northstar-phase4-invite.mjs"
readonly result_path="/tmp/northstar-phase4-invite-result.json"

cleanup() {
  docker exec brain-prod-api rm -f "$script_path" "$result_path" >/dev/null 2>&1 || true
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
       AND m.active = TRUE;
    COMMIT;"
} | tr -d '\r' | sed '/^$/d')"

if [[ "$(printf '%s\n' "$bootstrap_external_ref" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "northstar_invite_recovery_failed=bootstrap_admin_identity_not_unique" >&2
  exit 1
fi

docker cp /tmp/issue-northstar-phase4-invite.mjs "brain-prod-api:$script_path"
ciphertext="$(docker exec \
  -e "NORTHSTAR_BOOTSTRAP_EXTERNAL_REF=$bootstrap_external_ref" \
  -e "NORTHSTAR_RESULT_PATH=$result_path" \
  brain-prod-api node "$script_path")"

metadata="$(docker exec brain-prod-api cat "$result_path")"
printf '%s' "$metadata" | docker exec -i brain-prod-api node -e '
let text=""; process.stdin.on("data", (chunk) => text += chunk); process.stdin.on("end", () => {
  const value = JSON.parse(text);
  const ok = value.status === "completed" && typeof value.member_id === "string" &&
    typeof value.reissue === "boolean" && value.invite_expires_in_hours === 72;
  process.exit(ok ? 0 : 1);
});
'

if [[ ! "$ciphertext" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
  echo "northstar_invite_recovery_failed=ciphertext_shape_invalid" >&2
  exit 1
fi

printf '%s\n' "$ciphertext"
printf '%s\n' "northstar_invite_issuance_completed"
