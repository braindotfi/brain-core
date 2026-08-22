#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly tenant_id="tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ"
readonly recipient_email="braindotfi@gmail.com"
readonly bootstrap_external_ref_prefix="northstar-production-presenter-bootstrap:"
readonly script_path="/tmp/issue-production-presenter-invite.mjs"
readonly result_path="/tmp/production-presenter-invite-result.json"
readonly token_path="/tmp/production-presenter-invite-token"
readonly host_secret_dir="/home/azureuser/.brain-secrets"
readonly host_token_path="$host_secret_dir/northstar-presenter-invite-token"
readonly host_metadata_path="$host_secret_dir/northstar-presenter-invite-metadata.json"

host_token_tmp=""
host_metadata_tmp=""
cleanup() {
  docker exec brain-prod-api rm -f "$script_path" "$result_path" "$token_path" >/dev/null 2>&1 || true
  [[ -z "$host_token_tmp" ]] || rm -f "$host_token_tmp"
  [[ -z "$host_metadata_tmp" ]] || rm -f "$host_metadata_tmp"
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
       AND l.external_ref LIKE '${bootstrap_external_ref_prefix}%'
       AND m.email LIKE 'northstar-production-presenter-bootstrap+%@brain.invalid'
       AND m.role = 'admin'
       AND m.status = 'active'
       AND m.active = TRUE;
    COMMIT;"
} | tr -d '\r' | sed '/^$/d')"

if [[ "$(printf '%s\n' "$bootstrap_external_ref" | wc -l | tr -d ' ')" != "1" ]]; then
  echo "production_presenter_invite_failed=bootstrap_admin_identity_not_unique" >&2
  exit 1
fi

docker cp /tmp/issue-production-presenter-invite.mjs "brain-prod-api:$script_path"
docker exec \
  -e "NORTHSTAR_BOOTSTRAP_EXTERNAL_REF=$bootstrap_external_ref" \
  -e "PRODUCTION_PRESENTER_INVITE_RESULT_PATH=$result_path" \
  -e "PRODUCTION_PRESENTER_INVITE_TOKEN_PATH=$token_path" \
  brain-prod-api node "$script_path"

metadata="$(docker exec brain-prod-api cat "$result_path")"
readarray -t metadata_fields < <(printf '%s' "$metadata" | docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  const ok = value.status === "completed" &&
    value.tenant_id === "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ" &&
    value.email === "braindotfi@gmail.com" &&
    typeof value.member_id === "string" &&
    typeof value.token_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.token_sha256) &&
    Number.isSafeInteger(value.token_byte_length) && value.token_byte_length > 0 &&
    value.invite_expires_in_hours === 72 &&
    typeof value.reissue === "boolean";
  if (!ok) process.exit(1);
  process.stdout.write(`${value.token_sha256}\n${value.token_byte_length}\n`);
});
')
token_hash="${metadata_fields[0]}"
token_byte_length="${metadata_fields[1]}"

verification="$(docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
  BEGIN TRANSACTION READ ONLY;
  SELECT json_build_object(
    'tenant_id', t.id,
    'tenant_kind', t.kind,
    'sandbox', t.sandbox,
    'created_via', t.created_via,
    'member_id', m.id,
    'email', lower(btrim(m.email)),
    'role', m.role,
    'status', m.status,
    'active', m.active,
    'approval_domains', m.approval_domains,
    'per_item_limit_cents', m.per_item_limit_cents::text,
    'requires_second_approver_above_cents', m.requires_second_approver_above_cents,
    'invite_created_at', i.created_at,
    'expires_at', i.expires_at,
    'consumed_at', i.consumed_at,
    'revoked_at', i.revoked_at,
    'token_hash_matches', i.token_hash = '$token_hash',
    'valid_now', i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  )::text
    FROM tenants t
    JOIN members m ON m.tenant_id = t.id
    JOIN member_invites i
      ON i.tenant_id = m.tenant_id
     AND i.member_id = m.id
   WHERE t.id = '$tenant_id'
     AND lower(btrim(m.email)) = '$recipient_email'
     AND i.token_hash = '$token_hash';
  COMMIT;" | tr -d '\r' | sed '/^$/d')"

docker exec \
  -e "PRODUCTION_PRESENTER_INVITE_VERIFICATION=$verification" \
  brain-prod-api node -e '
const value = JSON.parse(process.env.PRODUCTION_PRESENTER_INVITE_VERIFICATION);
const domains = [...(value.approval_domains ?? [])].sort();
const expectedDomains = ["ap", "ar", "payroll", "reconciliation", "treasury"];
const ok = value.tenant_id === "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ" &&
  value.tenant_kind === "production" &&
  value.sandbox === false &&
  value.created_via === "admin" &&
  typeof value.member_id === "string" &&
  value.email === "braindotfi@gmail.com" &&
  value.role === "admin" &&
  value.status === "invited" &&
  value.active === false &&
  JSON.stringify(domains) === JSON.stringify(expectedDomains) &&
  value.per_item_limit_cents === "100000000" &&
  value.requires_second_approver_above_cents === null &&
  value.consumed_at === null &&
  value.revoked_at === null &&
  value.token_hash_matches === true &&
  value.valid_now === true;
if (!ok) process.exit(1);
process.stdout.write(`${JSON.stringify({
  event: "production_presenter_invite_verified",
  tenant_id: value.tenant_id,
  tenant_kind: value.tenant_kind,
  sandbox: value.sandbox,
  created_via: value.created_via,
  member_id: value.member_id,
  email: value.email,
  role: value.role,
  approval_domains: value.approval_domains,
  per_item_limit_cents: value.per_item_limit_cents,
  invite_created_at: value.invite_created_at,
  expires_at: value.expires_at,
  consumed_at: value.consumed_at,
  revoked_at: value.revoked_at,
  token_hash_matches: value.token_hash_matches,
  valid_now: value.valid_now,
})}\n`);
'

install -d -m 700 "$host_secret_dir"
host_token_tmp="$(mktemp "$host_secret_dir/.northstar-presenter-invite-token.XXXXXX")"
host_metadata_tmp="$(mktemp "$host_secret_dir/.northstar-presenter-invite-metadata.XXXXXX")"
docker cp "brain-prod-api:$token_path" "$host_token_tmp"
docker cp "brain-prod-api:$result_path" "$host_metadata_tmp"
chmod 600 "$host_token_tmp" "$host_metadata_tmp"

retained_hash="$(sha256sum "$host_token_tmp" | cut -d ' ' -f 1)"
retained_length="$(wc -c < "$host_token_tmp" | tr -d ' ')"
if [[ "$retained_hash" != "$token_hash" || "$retained_length" != "$token_byte_length" ]]; then
  echo "production_presenter_invite_failed=retained_token_verification_failed" >&2
  exit 1
fi

mv -f "$host_token_tmp" "$host_token_path"
host_token_tmp=""
mv -f "$host_metadata_tmp" "$host_metadata_path"
host_metadata_tmp=""
chmod 600 "$host_token_path" "$host_metadata_path"
if [[ "$(stat -c '%a' "$host_token_path")" != "600" || "$(stat -c '%a' "$host_metadata_path")" != "600" ]]; then
  echo "production_presenter_invite_failed=retained_file_mode_invalid" >&2
  exit 1
fi

printf '%s\n' "production_presenter_invite_token_retained_mode_0600"
printf '%s\n' "production_presenter_invite_issuance_completed"
