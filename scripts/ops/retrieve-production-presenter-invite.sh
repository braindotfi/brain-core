#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${PRESENTER_RETRIEVAL_PUBLIC_KEY_SHA256:?PRESENTER_RETRIEVAL_PUBLIC_KEY_SHA256 is required}"

readonly tenant_id="tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ"
readonly recipient_email="braindotfi@gmail.com"
readonly token_path="/home/azureuser/.brain-secrets/northstar-presenter-invite-token"
readonly metadata_path="/home/azureuser/.brain-secrets/northstar-presenter-invite-metadata.json"
readonly public_key_path="/tmp/production-presenter-retrieval-public.pem"

for path in "$token_path" "$metadata_path"; do
  if [[ ! -f "$path" || "$(stat -c '%a' "$path")" != "600" ]]; then
    echo "production_presenter_invite_retrieval_failed=retained_secret_invalid" >&2
    exit 1
  fi
done

actual_fingerprint="$(openssl pkey -pubin -in "$public_key_path" -outform DER | openssl dgst -sha256 -r | cut -d ' ' -f 1)"
if [[ "$actual_fingerprint" != "$PRESENTER_RETRIEVAL_PUBLIC_KEY_SHA256" ]]; then
  echo "production_presenter_invite_retrieval_failed=public_key_fingerprint_mismatch" >&2
  exit 1
fi

readarray -t metadata_fields < <(docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  const ok = value.status === "completed" &&
    value.tenant_id === "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ" &&
    value.email === "braindotfi@gmail.com" &&
    typeof value.member_id === "string" &&
    typeof value.token_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.token_sha256) &&
    Number.isSafeInteger(value.token_byte_length) && value.token_byte_length > 0;
  if (!ok) process.exit(1);
  process.stdout.write(`${value.member_id}\n${value.token_sha256}\n${value.token_byte_length}\n`);
});
' < "$metadata_path")
member_id="${metadata_fields[0]}"
token_hash="${metadata_fields[1]}"
token_byte_length="${metadata_fields[2]}"

retained_hash="$(sha256sum "$token_path" | cut -d ' ' -f 1)"
retained_length="$(wc -c < "$token_path" | tr -d ' ')"
if [[ "$retained_hash" != "$token_hash" || "$retained_length" != "$token_byte_length" ]]; then
  echo "production_presenter_invite_retrieval_failed=retained_token_hash_mismatch" >&2
  exit 1
fi

verification="$(docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
  BEGIN TRANSACTION READ ONLY;
  SELECT json_build_object(
    'tenant_id', t.id,
    'tenant_kind', t.kind,
    'sandbox', t.sandbox,
    'member_id', m.id,
    'email', lower(btrim(m.email)),
    'role', m.role,
    'status', m.status,
    'active', m.active,
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
     AND m.id = '$member_id'
     AND lower(btrim(m.email)) = '$recipient_email'
     AND i.token_hash = '$token_hash';
  COMMIT;" | tr -d '\r' | sed '/^$/d')"

docker exec -e "PRESENTER_INVITE_VERIFICATION=$verification" brain-prod-api node -e '
const value = JSON.parse(process.env.PRESENTER_INVITE_VERIFICATION);
const ok = value.tenant_id === "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ" &&
  value.tenant_kind === "production" &&
  value.sandbox === false &&
  typeof value.member_id === "string" &&
  value.email === "braindotfi@gmail.com" &&
  value.role === "admin" &&
  value.status === "invited" &&
  value.active === false &&
  value.consumed_at === null &&
  value.revoked_at === null &&
  value.token_hash_matches === true &&
  value.valid_now === true;
if (!ok) process.exit(1);
process.stdout.write(`${JSON.stringify({
  event: "production_presenter_invite_retrieval_verified",
  tenant_id: value.tenant_id,
  member_id: value.member_id,
  email: value.email,
  expires_at: value.expires_at,
  valid_now: value.valid_now,
})}\n`);
'

ciphertext="$(openssl pkeyutl -encrypt \
  -pubin \
  -inkey "$public_key_path" \
  -pkeyopt rsa_padding_mode:oaep \
  -pkeyopt rsa_oaep_md:sha256 \
  -pkeyopt rsa_mgf1_md:sha256 \
  -in "$token_path" | base64 | tr -d '\n')"
if [[ "${#ciphertext}" != "684" || "$(printf '%s' "$ciphertext" | base64 -d | wc -c | tr -d ' ')" != "512" ]]; then
  echo "production_presenter_invite_retrieval_failed=ciphertext_invalid" >&2
  exit 1
fi

printf 'invite_ciphertext=%s\n' "$ciphertext"
printf '%s\n' "production_presenter_invite_retrieval_completed"
