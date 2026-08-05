#!/usr/bin/env bash
#
# Production-only cleanup for the 33 durable tenants accidentally created by
# the demo routing regression from 2026-08-03 through 2026-08-04.
#
# This script deliberately has no tenant-id input. It invokes the audited
# self-service deletion route with a member session for this exact fixed set,
# rather than issuing raw DELETE statements. That service deletes all
# tenant-scoped rows transactionally and intentionally retains audit evidence.

set -euo pipefail

readonly API_BASE="https://api.brain.fi"
readonly EXPECTED_COUNT=33
readonly CREATED_AFTER="2026-08-03 14:25:00+00"
readonly CREATED_BEFORE="2026-08-04 09:47:59+00"
readonly PROTECTED_SHARED_DEMO="tnt_01KYAT7A1QRKHTYW9H4RAR2SEX"
readonly PROTECTED_DAMON="tnt_01KYAT31JH0G043K77H8SKYG4N"
readonly TARGET_TENANTS=(
  tnt_01KZ407JN0JJJCQ6MK50K9E71M
  tnt_01KZ4261MVPVHES3CZWXPQ670R
  tnt_01KZ42R3S7DJSHZQ9HKF9TVAXT
  tnt_01KZ4H11X1SSB7VNHNH98P5VZF
  tnt_01KZ4JM7FVNCQ4MQKQRJZGY4M6
  tnt_01KZ4KXCJR7N46DMCGNCWT4MK1
  tnt_01KZ4N6RMGMZVZHZ9CT6GXC8K4
  tnt_01KZ4NXR2J7S4CQ67T94R5FXFG
  tnt_01KZ4PXW8WAP28Z9EX6DNEGXMD
  tnt_01KZ4VBJDTKK8YB78QTKAPC0Y1
  tnt_01KZ4XFDYZQ4WQJEJDQV4MSV7K
  tnt_01KZ4XWTY736G5TYNT8NY1MNAS
  tnt_01KZ4YY096GFB4G5FPSC5W2YS8
  tnt_01KZ4YZP5DBBM6EAN0BWT6YX05
  tnt_01KZ527EK1RFKNS6YG5R1Y4M1F
  tnt_01KZ52DZVV1QWGQ178HF2Q1S3F
  tnt_01KZ52FDJ3357G2G076R4103Z7
  tnt_01KZ52N83RD0MTW1J00CQVFF2F
  tnt_01KZ537WB7QWANH781GKWVMP28
  tnt_01KZ546Y9ZZ3FE9XXRX82RFMXJ
  tnt_01KZ54AP2VSK6A4N5K1MBT8WY3
  tnt_01KZ54ZVAPNFBRJHY0R7R5G003
  tnt_01KZ5535M8ET0S92X0E4KN63NX
  tnt_01KZ55XEQXNCHBVX780CDAF2PX
  tnt_01KZ56C1XBQJWDZMT88SZBWWC6
  tnt_01KZ58EB94R4G2SDVA2R1WEAWE
  tnt_01KZ58WMBRS885XDXV8BHPQ4HM
  tnt_01KZ59APP8RSJM0QKXB1A7SDRD
  tnt_01KZ59HV17J2ZYGQXZY3BW69JQ
  tnt_01KZ5BEV3JWPQED6D025JFVSWQ
  tnt_01KZ60F7453G17GV3S9H0T1C5A
  tnt_01KZ62JZKCH8Y5T7J9XPN05E4E
  tnt_01KZ62QGE4JT459M5PFW5QHSEA
)

if [[ "${CONFIRMATION:-}" != "DELETE_33_ORPHAN_DEMO_TENANTS" ]]; then
  echo "confirmation must equal DELETE_33_ORPHAN_DEMO_TENANTS"
  exit 1
fi
if [[ -z "${VM_HOST:-}" || -z "${VM_SSH_KEY:-}" ]]; then
  echo "VM_HOST and VM_SSH_KEY must be configured by the production workflow"
  exit 1
fi
if [[ "${#TARGET_TENANTS[@]}" -ne "$EXPECTED_COUNT" ]]; then
  echo "fixed target count does not equal $EXPECTED_COUNT"
  exit 1
fi
if [[ "$(printf '%s\n' "${TARGET_TENANTS[@]}" | sort -u | wc -l | tr -d ' ')" -ne "$EXPECTED_COUNT" ]]; then
  echo "fixed target list contains duplicates"
  exit 1
fi
for tenant_id in "${TARGET_TENANTS[@]}"; do
  if [[ ! "$tenant_id" =~ ^tnt_[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
    echo "fixed target has invalid tenant id: $tenant_id"
    exit 1
  fi
  if [[ "$tenant_id" == "$PROTECTED_SHARED_DEMO" || "$tenant_id" == "$PROTECTED_DAMON" ]]; then
    echo "protected tenant was present in the target list"
    exit 1
  fi
done

ssh -i ~/.ssh/id_deploy -o ServerAliveInterval=30 "azureuser@$VM_HOST" \
  "CONFIRMATION='$CONFIRMATION' bash -s" <<'REMOTE'
set -euo pipefail

readonly API_BASE="https://api.brain.fi"
readonly EXPECTED_COUNT=33
readonly CREATED_AFTER="2026-08-03 14:25:00+00"
readonly CREATED_BEFORE="2026-08-04 09:47:59+00"
readonly TARGET_TENANTS=(
  tnt_01KZ407JN0JJJCQ6MK50K9E71M
  tnt_01KZ4261MVPVHES3CZWXPQ670R
  tnt_01KZ42R3S7DJSHZQ9HKF9TVAXT
  tnt_01KZ4H11X1SSB7VNHNH98P5VZF
  tnt_01KZ4JM7FVNCQ4MQKQRJZGY4M6
  tnt_01KZ4KXCJR7N46DMCGNCWT4MK1
  tnt_01KZ4N6RMGMZVZHZ9CT6GXC8K4
  tnt_01KZ4NXR2J7S4CQ67T94R5FXFG
  tnt_01KZ4PXW8WAP28Z9EX6DNEGXMD
  tnt_01KZ4VBJDTKK8YB78QTKAPC0Y1
  tnt_01KZ4XFDYZQ4WQJEJDQV4MSV7K
  tnt_01KZ4XWTY736G5TYNT8NY1MNAS
  tnt_01KZ4YY096GFB4G5FPSC5W2YS8
  tnt_01KZ4YZP5DBBM6EAN0BWT6YX05
  tnt_01KZ527EK1RFKNS6YG5R1Y4M1F
  tnt_01KZ52DZVV1QWGQ178HF2Q1S3F
  tnt_01KZ52FDJ3357G2G076R4103Z7
  tnt_01KZ52N83RD0MTW1J00CQVFF2F
  tnt_01KZ537WB7QWANH781GKWVMP28
  tnt_01KZ546Y9ZZ3FE9XXRX82RFMXJ
  tnt_01KZ54AP2VSK6A4N5K1MBT8WY3
  tnt_01KZ54ZVAPNFBRJHY0R7R5G003
  tnt_01KZ5535M8ET0S92X0E4KN63NX
  tnt_01KZ55XEQXNCHBVX780CDAF2PX
  tnt_01KZ56C1XBQJWDZMT88SZBWWC6
  tnt_01KZ58EB94R4G2SDVA2R1WEAWE
  tnt_01KZ58WMBRS885XDXV8BHPQ4HM
  tnt_01KZ59APP8RSJM0QKXB1A7SDRD
  tnt_01KZ59HV17J2ZYGQXZY3BW69JQ
  tnt_01KZ5BEV3JWPQED6D025JFVSWQ
  tnt_01KZ60F7453G17GV3S9H0T1C5A
  tnt_01KZ62JZKCH8Y5T7J9XPN05E4E
  tnt_01KZ62QGE4JT459M5PFW5QHSEA
)

if [[ "$CONFIRMATION" != "DELETE_33_ORPHAN_DEMO_TENANTS" ]]; then
  echo "remote confirmation failed"
  exit 1
fi

cd ~/brain-core
set -a
. ./.env.prod
set +a
if [[ -z "${BRAIN_PLATFORM_SERVICE_SECRET:-}" ]]; then
  echo "BRAIN_PLATFORM_SERVICE_SECRET is not configured on the production VM"
  exit 1
fi

targets_sql="$(printf "('%s')," "${TARGET_TENANTS[@]}")"
targets_sql="${targets_sql%,}"
preflight="$(
  docker exec -i brain-prod-postgres psql -U brain -d brain -At -F $'\t' \
    -v ON_ERROR_STOP=1 \
    -v created_after="$CREATED_AFTER" \
    -v created_before="$CREATED_BEFORE" <<SQL
WITH targets(id) AS (VALUES $targets_sql)
SELECT targets.id,
       CASE WHEN t.id IS NOT NULL THEN 'present' ELSE 'missing' END AS tenant_state,
       COALESCE(t.kind, '') AS kind,
       COALESCE(t.sandbox::text, '') AS sandbox,
       CASE WHEN t.created_at >= :'created_after'::timestamptz
                  AND t.created_at <= :'created_before'::timestamptz
            THEN 'within_window'
            ELSE 'outside_window'
        END AS created_window,
       CASE WHEN EXISTS (
              SELECT 1
                FROM members m
               WHERE m.tenant_id = targets.id
                 AND m.email LIKE 'demo-fresh-%@brain.fi'
            ) THEN 'expected_member'
            ELSE 'unexpected_member'
        END AS member_check,
       CASE WHEN EXISTS (
              SELECT 1
                FROM member_identity_links l
                JOIN members m
                  ON m.tenant_id = l.tenant_id
                 AND m.id = l.member_id
               WHERE l.tenant_id = targets.id
                 AND l.surface = 'platform'
                 AND m.status = 'active'
            ) THEN 'platform_linked'
            ELSE 'platform_link_missing'
        END AS session_check,
       COALESCE((
          SELECT count(*)
            FROM raw_artifacts ra
           WHERE ra.tenant_id = targets.id
             AND ra.blob_uri IS NOT NULL
        ), 0) AS blob_artifact_count
  FROM targets
  LEFT JOIN tenants t ON t.id = targets.id
 ORDER BY targets.id;
SQL
)"

echo "preflight tenant_id tenant_state kind sandbox created_window member_check session_check blob_artifact_count"
printf '%s\n' "$preflight"
preflight_failures="$(
  printf '%s\n' "$preflight" | awk -F $'\t' '
    $2 != "present" || $3 != "production" || $4 != "false" ||
    $5 != "within_window" || $6 != "expected_member" ||
    $7 != "platform_linked" || $8 != "0" { print $1 }
  '
)"
if [[ -n "$preflight_failures" ]]; then
  echo "preflight failed. No tenants were deleted."
  printf '%s\n' "$preflight_failures"
  exit 1
fi
if [[ "$(printf '%s\n' "$preflight" | sed '/^$/d' | wc -l | tr -d ' ')" -ne "$EXPECTED_COUNT" ]]; then
  echo "preflight did not return all expected tenants. No tenants were deleted."
  exit 1
fi

count_before() {
  local tenant_id="$1"
  docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 -v tenant_id="$tenant_id" <<'SQL'
SELECT json_build_object(
  'raw_artifacts', (SELECT count(*) FROM raw_artifacts WHERE tenant_id = :'tenant_id'),
  'raw_sources', (SELECT count(*) FROM raw_sources WHERE tenant_id = :'tenant_id'),
  'raw_parsed', (SELECT count(*) FROM raw_parsed WHERE tenant_id = :'tenant_id'),
  'canonical_accounts', (SELECT count(*) FROM canonical_account WHERE tenant_id = :'tenant_id'),
  'canonical_transactions', (SELECT count(*) FROM canonical_transaction WHERE tenant_id = :'tenant_id'),
  'canonical_obligations', (SELECT count(*) FROM canonical_obligation WHERE tenant_id = :'tenant_id'),
  'ledger_accounts', (SELECT count(*) FROM ledger_accounts WHERE owner_id = :'tenant_id'),
  'ledger_transactions', (SELECT count(*) FROM ledger_transactions WHERE owner_id = :'tenant_id'),
  'ledger_invoices', (SELECT count(*) FROM ledger_invoices WHERE owner_id = :'tenant_id'),
  'ledger_obligations', (SELECT count(*) FROM ledger_obligations WHERE owner_id = :'tenant_id'),
  'ledger_counterparties', (SELECT count(*) FROM ledger_counterparties WHERE owner_id = :'tenant_id'),
  'policies', (SELECT count(*) FROM policies WHERE tenant_id = :'tenant_id'),
  'agent_runs', (SELECT count(*) FROM agent_runs WHERE tenant_id = :'tenant_id'),
  'agents', (SELECT count(*) FROM agents WHERE tenant_id = :'tenant_id'),
  'proposals', (SELECT count(*) FROM proposals WHERE tenant_id = :'tenant_id'),
  'members', (SELECT count(*) FROM members WHERE tenant_id = :'tenant_id'),
  'users', (SELECT count(*) FROM users WHERE tenant_id = :'tenant_id')
);
SQL
}

count_after() {
  local tenant_id="$1"
  docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 -v tenant_id="$tenant_id" <<'SQL'
SELECT json_build_object(
  'tenant_exists', EXISTS (SELECT 1 FROM tenants WHERE id = :'tenant_id'),
  'raw_artifacts', (SELECT count(*) FROM raw_artifacts WHERE tenant_id = :'tenant_id'),
  'raw_sources', (SELECT count(*) FROM raw_sources WHERE tenant_id = :'tenant_id'),
  'raw_parsed', (SELECT count(*) FROM raw_parsed WHERE tenant_id = :'tenant_id'),
  'canonical_accounts', (SELECT count(*) FROM canonical_account WHERE tenant_id = :'tenant_id'),
  'canonical_transactions', (SELECT count(*) FROM canonical_transaction WHERE tenant_id = :'tenant_id'),
  'canonical_obligations', (SELECT count(*) FROM canonical_obligation WHERE tenant_id = :'tenant_id'),
  'ledger_accounts', (SELECT count(*) FROM ledger_accounts WHERE owner_id = :'tenant_id'),
  'ledger_transactions', (SELECT count(*) FROM ledger_transactions WHERE owner_id = :'tenant_id'),
  'ledger_invoices', (SELECT count(*) FROM ledger_invoices WHERE owner_id = :'tenant_id'),
  'ledger_obligations', (SELECT count(*) FROM ledger_obligations WHERE owner_id = :'tenant_id'),
  'ledger_counterparties', (SELECT count(*) FROM ledger_counterparties WHERE owner_id = :'tenant_id'),
  'policies', (SELECT count(*) FROM policies WHERE tenant_id = :'tenant_id'),
  'agent_runs', (SELECT count(*) FROM agent_runs WHERE tenant_id = :'tenant_id'),
  'agents', (SELECT count(*) FROM agents WHERE tenant_id = :'tenant_id'),
  'proposals', (SELECT count(*) FROM proposals WHERE tenant_id = :'tenant_id'),
  'members', (SELECT count(*) FROM members WHERE tenant_id = :'tenant_id'),
  'users', (SELECT count(*) FROM users WHERE tenant_id = :'tenant_id')
);
SQL
}

for tenant_id in "${TARGET_TENANTS[@]}"; do
  external_ref="$(
    docker exec -i brain-prod-postgres psql -U brain -d brain -At -v ON_ERROR_STOP=1 -v tenant_id="$tenant_id" <<'SQL'
SELECT l.external_ref
  FROM member_identity_links l
  JOIN members m
    ON m.tenant_id = l.tenant_id
   AND m.id = l.member_id
 WHERE l.tenant_id = :'tenant_id'
   AND l.surface = 'platform'
   AND m.status = 'active'
 ORDER BY CASE WHEN m.role = 'admin' THEN 0 ELSE 1 END, l.linked_at ASC
 LIMIT 1;
SQL
  )"
  if [[ -z "$external_ref" ]]; then
    echo "No active platform identity link for $tenant_id. Stopping before this tenant."
    exit 1
  fi

  before="$(count_before "$tenant_id")"
  session_json="$(
    docker exec -e EXTERNAL_REF="$external_ref" brain-prod-api node -e '
      process.stdout.write(JSON.stringify({ external_ref: process.env.EXTERNAL_REF }));
    ' | curl -fsS --retry 2 --connect-timeout 10 --max-time 30 \
      -X POST "$API_BASE/v1/sessions" \
      -H "Content-Type: application/json" \
      -H "X-Platform-Service-Auth: ${BRAIN_PLATFORM_SERVICE_SECRET}" \
      --data-binary @-
  )"
  token="$(
    printf '%s' "$session_json" | docker exec -i brain-prod-api node -e '
      let body = "";
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        const parsed = JSON.parse(body);
        if (typeof parsed.token !== "string" || parsed.token.length === 0) process.exit(1);
        process.stdout.write(parsed.token);
      });
    '
  )"
  delete_response="$(
    curl -fsS --retry 1 --connect-timeout 10 --max-time 90 \
      -X DELETE "$API_BASE/v1/tenants/$tenant_id" \
      -H "Authorization: Bearer $token"
  )"
  deleted_summary="$(
    printf '%s' "$delete_response" | TENANT_ID="$tenant_id" docker exec -i -e TENANT_ID brain-prod-api node -e '
      let body = "";
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        const parsed = JSON.parse(body);
        if (parsed.tenantId !== process.env.TENANT_ID || parsed.deletedRows?.tenants !== 1) process.exit(1);
        if (parsed.blobArtifactCount !== 0 || (parsed.blobUrisPendingPurge ?? []).length !== 0) process.exit(1);
        process.stdout.write(JSON.stringify({
          total_rows: parsed.totalRows,
          deleted_rows: parsed.deletedRows,
          blob_artifact_count: parsed.blobArtifactCount,
          blob_purge_job_id: parsed.blobPurgeJobId,
        }));
      });
    '
  )"
  after="$(count_after "$tenant_id")"
  printf '%s' "$after" | docker exec -i brain-prod-api node -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(body);
      if (value.tenant_exists !== false || Object.entries(value).some(([key, count]) => key !== "tenant_exists" && count !== 0)) process.exit(1);
    });
  '
  printf 'tenant_id=%s before=%s deleted=%s after=%s audit_chain_preserved=true\n' \
    "$tenant_id" "$before" "$deleted_summary" "$after"
done

echo "cleanup_complete target_count=$EXPECTED_COUNT"
echo "preserved_tables=audit_events,audit_anchors,tenant_blob_purge_jobs,tenant_blob_purge_audit_outbox,audit_integrity_findings"
REMOTE
