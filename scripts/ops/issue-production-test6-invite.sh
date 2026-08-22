#!/usr/bin/env bash
set -euo pipefail

readonly tenant_id="tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ"
readonly recipient_email="braindotfi+test6@gmail.com"
readonly script_path="/tmp/issue-production-test6-invite.mjs"
readonly result_path="/tmp/production-test6-invite-result.json"

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
  echo "production_test6_invite_failed=bootstrap_admin_identity_not_unique" >&2
  exit 1
fi

docker cp /tmp/issue-production-test6-invite.mjs "brain-prod-api:$script_path"
ciphertext="$(docker exec \
  -e "NORTHSTAR_BOOTSTRAP_EXTERNAL_REF=$bootstrap_external_ref" \
  -e "PRODUCTION_TEST6_INVITE_RESULT_PATH=$result_path" \
  brain-prod-api node "$script_path")"

metadata="$(docker exec brain-prod-api cat "$result_path")"
token_hash="$(printf '%s' "$metadata" | docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  const ok = value.status === "completed" &&
    value.tenant_id === "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ" &&
    value.email === "braindotfi+test6@gmail.com" &&
    typeof value.member_id === "string" &&
    typeof value.token_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.token_sha256) &&
    value.public_key_sha256 === "9862158de969b874ca02ed2ea63acbfe8c7dc954f3ebc12391ac4759cd03e12a" &&
    value.invite_expires_in_hours === 72 &&
    typeof value.reissue === "boolean";
  if (!ok) process.exit(1);
  process.stdout.write(value.token_sha256);
});
')"

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
  -e "PRODUCTION_TEST6_INVITE_VERIFICATION=$verification" \
  brain-prod-api node -e '
const value = JSON.parse(process.env.PRODUCTION_TEST6_INVITE_VERIFICATION);
const domains = [...(value.approval_domains ?? [])].sort();
const expectedDomains = ["ap", "ar", "payroll", "reconciliation", "treasury"];
const ok = value.tenant_id === "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ" &&
  value.tenant_kind === "production" &&
  value.sandbox === false &&
  value.created_via === "admin" &&
  typeof value.member_id === "string" &&
  value.email === "braindotfi+test6@gmail.com" &&
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
  event: "production_test6_invite_verified",
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

if [[ ! "$ciphertext" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
  echo "production_test6_invite_failed=ciphertext_shape_invalid" >&2
  exit 1
fi
if [[ "${#ciphertext}" != "684" ]]; then
  echo "production_test6_invite_failed=ciphertext_length_invalid" >&2
  exit 1
fi
if [[ "$(printf '%s' "$ciphertext" | base64 -d | wc -c | tr -d ' ')" != "512" ]]; then
  echo "production_test6_invite_failed=ciphertext_decoded_length_invalid" >&2
  exit 1
fi

printf 'invite_ciphertext=%s\n' "$ciphertext"
printf '%s\n' "production_test6_invite_issuance_completed"
