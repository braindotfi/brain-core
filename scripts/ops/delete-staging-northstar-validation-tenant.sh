#!/usr/bin/env bash
set -euo pipefail

# Fixed, staging-only cleanup for the isolated Northstar validation tenant.
# The BrainMVB lookup is mandatory: core cannot see the platform's separate
# brain_identities mapping, so deletion must stop unless BrainMVB confirms no link.

readonly TENANT_ID='tnt_01M0909Z6WCCPB4MG0SWJ07VJX'
readonly NORTHSTAR_SEED_KEY='northstar_labs_v1'
readonly API_BASE='https://staging-api.brain.fi'
readonly DEFAULT_BRAINMVB_BASE_URL='https://app.brain.fi'
readonly APPLY_CONFIRMATION='DELETE_NORTHSTAR_STAGING_VALIDATION_TENANT'

mode="${MODE:-report}"
confirmation="${CONFIRMATION:-}"

if [[ "$mode" != 'report' && "$mode" != 'apply' ]]; then
  echo 'mode must be report or apply' >&2
  exit 1
fi
if [[ "$mode" == 'apply' && "$confirmation" != "$APPLY_CONFIRMATION" ]]; then
  echo "apply requires the exact confirmation string $APPLY_CONFIRMATION" >&2
  exit 1
fi

cd ~/brain-core
set -a
. ./.env.staging
set +a

: "${BRAIN_PLATFORM_SERVICE_SECRET:?BRAIN_PLATFORM_SERVICE_SECRET is required}"
brainmvb_base_url="${BRAINMVB_INTERNAL_BASE_URL:-$DEFAULT_BRAINMVB_BASE_URL}"
brainmvb_base_url="${brainmvb_base_url%/}"

if [[ ! "$brainmvb_base_url" =~ ^https:// ]]; then
  echo 'BRAINMVB_INTERNAL_BASE_URL must use https' >&2
  exit 1
fi

identity_response_path="$(mktemp)"
trap 'rm -f "$identity_response_path" /tmp/northstar-validation-delete-response.json' EXIT
identity_status="$(curl -sS --connect-timeout 10 --max-time 30 \
  -o "$identity_response_path" \
  -w '%{http_code}' \
  -H "X-Platform-Service-Auth: ${BRAIN_PLATFORM_SERVICE_SECRET}" \
  "$brainmvb_base_url/internal/brain-identities/$TENANT_ID")"

if [[ "$identity_status" != '200' ]]; then
  echo "brainmvb_identity_lookup_status=$identity_status" >&2
  echo 'BrainMVB identity lookup did not return 200. No deletion was attempted.' >&2
  exit 1
fi

identity_summary="$(cat "$identity_response_path" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const parsed = JSON.parse(body);
    if (parsed?.linked !== false) process.exit(1);
    process.stdout.write(JSON.stringify({ linked: false }));
  });
')"
printf 'brainmvb_identity_lookup=%s\n' "$identity_summary"

preflight="$(docker exec -i brain-prod-postgres psql -qAt -U brain -d brain -v ON_ERROR_STOP=1 \
  -c "BEGIN TRANSACTION READ ONLY;
      SET LOCAL statement_timeout = '15s';
      WITH identity_link_summary AS (
        SELECT json_build_object(
          'link_count', count(*),
          'all_links_belong_to_tenant', bool_and(l.tenant_id = '$TENANT_ID'),
          'synthetic_bootstrap_link_count', count(*) FILTER (
            WHERE l.surface = 'platform'
              AND m.role = 'admin'
              AND m.status = 'active'
              AND m.active = TRUE
              AND m.email ~ '^northstar-phase4\\+[0-9a-f]{32}@brain\\.invalid$'
              AND l.external_ref ~ '^northstar-phase4:[0-9a-f]{32}$'
              AND substring(m.email FROM '^northstar-phase4\\+([0-9a-f]{32})@brain\\.invalid$')
                = substring(l.external_ref FROM '^northstar-phase4:([0-9a-f]{32})$')
          ),
          'linked_member_is_active_synthetic_bootstrap_admin', bool_and(
            l.surface = 'platform'
            AND m.role = 'admin'
            AND m.status = 'active'
            AND m.active = TRUE
            AND m.email ~ '^northstar-phase4\\+[0-9a-f]{32}@brain\\.invalid$'
            AND l.external_ref ~ '^northstar-phase4:[0-9a-f]{32}$'
            AND substring(m.email FROM '^northstar-phase4\\+([0-9a-f]{32})@brain\\.invalid$')
              = substring(l.external_ref FROM '^northstar-phase4:([0-9a-f]{32})$')
          )
        ) AS value
          FROM member_identity_links l
          JOIN members m
            ON m.tenant_id = l.tenant_id
           AND m.id = l.member_id
         WHERE l.tenant_id = '$TENANT_ID'
      )
      SELECT json_build_object(
        'tenant_rows', (SELECT count(*) FROM tenants WHERE id = '$TENANT_ID'),
        'tenant_kind', (SELECT kind FROM tenants WHERE id = '$TENANT_ID'),
        'tenant_sandbox', (SELECT sandbox FROM tenants WHERE id = '$TENANT_ID'),
        'tenant_created_via', (SELECT created_via FROM tenants WHERE id = '$TENANT_ID'),
        'seed_marker_count', (
          SELECT count(*) FROM policies
           WHERE tenant_id = '$TENANT_ID' AND content->>'seed_key' = '$NORTHSTAR_SEED_KEY'
        ),
        'identity_link', (SELECT value FROM identity_link_summary),
        'active_invite_count', (
          SELECT count(*) FROM member_invites
           WHERE tenant_id = '$TENANT_ID' AND consumed_at IS NULL AND revoked_at IS NULL
             AND expires_at > now()
        ),
        'api_key_count', (SELECT count(*) FROM api_keys WHERE tenant_id = '$TENANT_ID'),
        'member_count', (SELECT count(*) FROM members WHERE tenant_id = '$TENANT_ID'),
        'non_synthetic_member_count', (
          SELECT count(*) FROM members
           WHERE tenant_id = '$TENANT_ID' AND email !~ '@brain\\.invalid$'
        ),
        'active_bootstrap_admin_count', (
          SELECT count(*) FROM members
           WHERE tenant_id = '$TENANT_ID' AND role = 'admin' AND active = TRUE
             AND status = 'active' AND email ~ '@brain\\.invalid$'
        ),
        'nonterminal_payment_intent_count', (
          SELECT count(*) FROM ledger_payment_intents
           WHERE owner_id = '$TENANT_ID'
             AND status NOT IN ('executed', 'rejected', 'failed', 'cancelled')
        ),
        'nonterminal_execution_count', (
          SELECT count(*) FROM executions
           WHERE tenant_id = '$TENANT_ID' AND status NOT IN ('completed', 'failed')
        ),
        'nonterminal_outbox_count', (
          SELECT count(*) FROM execution_outbox
           WHERE tenant_id = '$TENANT_ID' AND status NOT IN ('settled', 'failed')
        ),
        'rail_receipt_count', (
          (SELECT count(*) FROM executions
            WHERE tenant_id = '$TENANT_ID' AND rail_receipt IS NOT NULL)
          +
          (SELECT count(*) FROM execution_outbox
            WHERE tenant_id = '$TENANT_ID' AND rail_receipt IS NOT NULL)
        ),
        'blob_artifact_count', (
          SELECT count(*) FROM raw_artifacts
           WHERE tenant_id = '$TENANT_ID' AND blob_uri IS NOT NULL
        )
      );
      COMMIT;")"

printf 'northstar_validation_tenant_preflight=%s\n' "$preflight"
printf '%s' "$preflight" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    const identityLink = value.identity_link;
    const valid = value.tenant_rows === 1 && value.tenant_kind === "production" &&
      value.tenant_sandbox === false && value.tenant_created_via === "admin" &&
      value.seed_marker_count === 1 && identityLink?.link_count === 1 &&
      identityLink?.all_links_belong_to_tenant === true &&
      identityLink?.synthetic_bootstrap_link_count === 1 &&
      identityLink?.linked_member_is_active_synthetic_bootstrap_admin === true &&
      value.active_invite_count === 0 && value.api_key_count === 0 &&
      value.member_count >= 1 && value.non_synthetic_member_count === 0 &&
      value.active_bootstrap_admin_count === 1 && value.nonterminal_payment_intent_count === 0 &&
      value.nonterminal_execution_count === 0 && value.nonterminal_outbox_count === 0 &&
      value.rail_receipt_count === 0;
    if (!valid) process.exit(1);
  });
'

if [[ "$mode" == 'report' ]]; then
  echo 'northstar_validation_tenant_preflight_completed'
  exit 0
fi

member_id="$(docker exec -i brain-prod-postgres psql -qAt -U brain -d brain -v ON_ERROR_STOP=1 \
  -c "SELECT id FROM members
        WHERE tenant_id = '$TENANT_ID' AND role = 'admin' AND active = TRUE
          AND status = 'active' AND email ~ '@brain\\.invalid$'
        ORDER BY id;")"
if [[ ! "$member_id" =~ ^(usr|mem)_[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
  echo 'preflighted tenant does not have exactly one valid synthetic bootstrap admin' >&2
  exit 1
fi

member_token="$(docker exec -w /app/services/api \
  -e FIXTURE_TENANT_ID="$TENANT_ID" \
  -e FIXTURE_MEMBER_ID="$member_id" \
  brain-prod-api node --input-type=module -e '
    import { JwtSigner, newTokenId } from "@brain/shared";
    const key = JSON.parse(process.env.AUTH_SIGN_KEY);
    const signer = new JwtSigner({
      issuer: process.env.AUTH_ISSUER,
      audience: process.env.AUTH_AUDIENCE,
      key,
      algorithm: key.alg ?? "HS256",
    });
    process.stdout.write(await signer.sign({
      id: process.env.FIXTURE_MEMBER_ID,
      type: "user",
      tenantId: process.env.FIXTURE_TENANT_ID,
      tokenId: newTokenId(),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      scopes: ["execution:admin"],
    }));
  ')"

delete_status="$(curl -sS --connect-timeout 10 --max-time 90 \
  -o /tmp/northstar-validation-delete-response.json \
  -w '%{http_code}' \
  -X DELETE "$API_BASE/v1/tenants/$TENANT_ID" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $member_token" \
  --data "{\"confirm\":\"$TENANT_ID\"}")"

if [[ "$delete_status" != '200' ]]; then
  echo "northstar_validation_tenant_delete_status=$delete_status" >&2
  echo 'tenant deletion did not return 200' >&2
  exit 1
fi

delete_summary="$(cat /tmp/northstar-validation-delete-response.json | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (value.tenantId !== "tnt_01M0909Z6WCCPB4MG0SWJ07VJX" || value.deletedRows?.tenants !== 1) {
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      tenant_id: value.tenantId,
      total_rows: value.totalRows,
      deleted_rows: value.deletedRows,
      blob_artifact_count: value.blobArtifactCount,
      blob_purge_job_id: value.blobPurgeJobId,
    }));
  });
')"
printf 'northstar_validation_tenant_delete=%s\n' "$delete_summary"

postflight="$(docker exec -i brain-prod-postgres psql -qAt -U brain -d brain -v ON_ERROR_STOP=1 \
  -c "BEGIN TRANSACTION READ ONLY;
      SET LOCAL statement_timeout = '15s';
      SELECT json_build_object(
        'tenant_rows', (SELECT count(*) FROM tenants WHERE id = '$TENANT_ID'),
        'members', (SELECT count(*) FROM members WHERE tenant_id = '$TENANT_ID'),
        'identity_links', (SELECT count(*) FROM member_identity_links WHERE tenant_id = '$TENANT_ID'),
        'ledger_invoices', (SELECT count(*) FROM ledger_invoices WHERE owner_id = '$TENANT_ID'),
        'ledger_transactions', (SELECT count(*) FROM ledger_transactions WHERE owner_id = '$TENANT_ID'),
        'ledger_payment_intents', (SELECT count(*) FROM ledger_payment_intents WHERE owner_id = '$TENANT_ID'),
        'proposals', (SELECT count(*) FROM proposals WHERE tenant_id = '$TENANT_ID'),
        'execution_outbox', (SELECT count(*) FROM execution_outbox WHERE tenant_id = '$TENANT_ID'),
        'raw_artifacts', (SELECT count(*) FROM raw_artifacts WHERE tenant_id = '$TENANT_ID'),
        'policies', (SELECT count(*) FROM policies WHERE tenant_id = '$TENANT_ID'),
        'audit_delete_event_count', (
          SELECT count(*) FROM audit_events
           WHERE tenant_id = '$TENANT_ID' AND action = 'tenant.deleted'
        )
      );
      COMMIT;")"
printf 'northstar_validation_tenant_postflight=%s\n' "$postflight"
printf '%s' "$postflight" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    const deleted = [
      "tenant_rows", "members", "identity_links", "ledger_invoices", "ledger_transactions",
      "ledger_payment_intents", "proposals", "execution_outbox", "raw_artifacts", "policies",
    ].every((key) => value[key] === 0);
    if (!deleted || value.audit_delete_event_count < 1) process.exit(1);
  });
'

echo 'northstar_validation_tenant_delete_completed'
