#!/usr/bin/env bash
set -euo pipefail

: "${API_BASE:?API_BASE is required}"
: "${VM_ENV_FILE:?VM_ENV_FILE is required}"

readonly tenant_id="tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ"
readonly presenter_email="braindotfi+test6@gmail.com"

cd ~/brain-core
set -a
. "./${VM_ENV_FILE}"
set +a
: "${BRAIN_PLATFORM_SERVICE_SECRET:?BRAIN_PLATFORM_SERVICE_SECRET is required}"

tenant_state="$(docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
  BEGIN TRANSACTION READ ONLY;
  SELECT json_build_object(
    'tenant_id', id,
    'kind', kind,
    'sandbox', sandbox,
    'created_via', created_via
  )::text
    FROM tenants
   WHERE id = '$tenant_id';
  COMMIT;" | tr -d '\r' | sed '/^$/d')"

docker exec -e TENANT_STATE="$tenant_state" brain-prod-api node -e '
const value = JSON.parse(process.env.TENANT_STATE);
const ok = value.tenant_id === "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ" &&
  value.kind === "production" &&
  value.sandbox === false &&
  value.created_via === "admin";
process.exit(ok ? 0 : 1);
'

ledger_fingerprint() {
  docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
    BEGIN TRANSACTION READ ONLY;
    SELECT json_build_object(
      'accounts', (SELECT COUNT(*) FROM ledger_accounts WHERE owner_id = '$tenant_id'),
      'counterparties', (SELECT COUNT(*) FROM ledger_counterparties WHERE owner_id = '$tenant_id'),
      'transactions', (SELECT COUNT(*) FROM ledger_transactions WHERE owner_id = '$tenant_id'),
      'obligations', (SELECT COUNT(*) FROM ledger_obligations WHERE owner_id = '$tenant_id'),
      'invoices', (SELECT COUNT(*) FROM ledger_invoices WHERE owner_id = '$tenant_id'),
      'account_balances', (SELECT COALESCE(SUM(current_balance), 0)::text FROM ledger_accounts WHERE owner_id = '$tenant_id'),
      'transaction_amounts', (SELECT COALESCE(SUM(amount), 0)::text FROM ledger_transactions WHERE owner_id = '$tenant_id'),
      'obligation_amounts', (SELECT COALESCE(SUM(amount_due), 0)::text FROM ledger_obligations WHERE owner_id = '$tenant_id'),
      'invoice_amounts', (SELECT COALESCE(SUM(amount_due), 0)::text FROM ledger_invoices WHERE owner_id = '$tenant_id')
    )::text;
    COMMIT;" | tr -d '\r' | sed '/^$/d'
}

before_ledger="$(ledger_fingerprint)"
seed_result="$(docker exec -e BRAIN_TENANT_ID="$tenant_id" brain-prod-api node tools/seed-northstar-demo/dist/sources-cli.js)"
after_ledger="$(ledger_fingerprint)"
[[ "$before_ledger" == "$after_ledger" ]]

source_state="$(docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
  BEGIN TRANSACTION READ ONLY;
  SELECT json_build_object(
    'count', COUNT(*),
    'all_historical', BOOL_AND(status = 'historical'),
    'all_without_credentials', BOOL_AND(encrypted_credentials IS NULL AND credential_key_id IS NULL),
    'all_without_sync', BOOL_AND(last_synced_at IS NULL),
    'all_non_live', BOOL_AND(metadata->>'live_connection' = 'false'),
    'all_sync_disabled', BOOL_AND(metadata->>'sync_disabled' = 'true'),
    'names', json_agg(metadata->>'display_name' ORDER BY metadata->>'seed_source_key')
  )::text
    FROM raw_sources
   WHERE tenant_id = '$tenant_id'
     AND metadata->>'seed_key' = 'northstar_labs_v1';
  COMMIT;" | tr -d '\r' | sed '/^$/d')"

external_ref="$(docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
  BEGIN TRANSACTION READ ONLY;
  SELECT l.external_ref
    FROM member_identity_links l
    JOIN members m ON m.tenant_id = l.tenant_id AND m.id = l.member_id
   WHERE l.tenant_id = '$tenant_id'
     AND l.surface = 'platform'
     AND lower(btrim(m.email)) = '$presenter_email'
     AND m.status = 'active'
     AND m.active = TRUE;
  COMMIT;" | tr -d '\r' | sed '/^$/d')"
[[ "$(printf '%s\n' "$external_ref" | wc -l | tr -d ' ')" == "1" ]]

session_json="$(
  docker exec -e EXTERNAL_REF="$external_ref" brain-prod-api node -e '
    process.stdout.write(JSON.stringify({
      external_ref: process.env.EXTERNAL_REF,
      scopes: ["raw:read"],
    }));
  ' | curl -fsS --retry 2 --connect-timeout 10 --max-time 30 \
    -X POST "$API_BASE/v1/sessions" \
    -H "X-Platform-Service-Auth: ${BRAIN_PLATFORM_SERVICE_SECRET}" \
    -H 'Content-Type: application/json' \
    --data-binary @-
)"
token="$(printf '%s' "$session_json" | docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  if (typeof value.token !== "string" || value.token.length === 0) process.exit(1);
  process.stdout.write(value.token);
});
')"

api_response="$(curl -fsS --retry 2 --connect-timeout 10 --max-time 30 \
  "$API_BASE/v1/sources?status=historical&limit=50" \
  -H "Authorization: Bearer $token")"

docker exec \
  -e TENANT_ID="$tenant_id" \
  -e SOURCE_STATE="$source_state" \
  -e API_RESPONSE="$api_response" \
  -e LEDGER_FINGERPRINT="$after_ledger" \
  -e SEED_RESULT="$seed_result" \
  brain-prod-api node -e '
const tenantId = process.env.TENANT_ID;
const state = JSON.parse(process.env.SOURCE_STATE);
const response = JSON.parse(process.env.API_RESPONSE);
const ledger = JSON.parse(process.env.LEDGER_FINGERPRINT);
const seed = JSON.parse(process.env.SEED_RESULT);
const expectedNames = [
  "Harborline Bank Historical Export",
  "Internal Revenue Service Historical Tax Records",
  "Keystone Corporate Card Historical Export",
  "Meridian Benefits Payroll Historical Export",
  "Northstar Accounting Historical Export",
].sort();
const rows = response.data ?? [];
const names = rows.map((row) => row.metadata?.display_name).sort();
const rowsValid = rows.length === 5 && rows.every((row) =>
  row.tenantId === tenantId &&
  row.status === "historical" &&
  row.freshness === "not_applicable" &&
  row.last_synced_at === null &&
  row.metadata?.origin_mode === "historical_import" &&
  row.metadata?.live_connection === false &&
  row.metadata?.sync_disabled === true
);
const stateValid = state.count === 5 &&
  state.all_historical === true &&
  state.all_without_credentials === true &&
  state.all_without_sync === true &&
  state.all_non_live === true &&
  state.all_sync_disabled === true;
const ok = seed.tenantId === tenantId &&
  seed.created + seed.updated === 5 &&
  stateValid && rowsValid &&
  JSON.stringify(names) === JSON.stringify(expectedNames);
if (!ok) process.exit(1);
process.stdout.write(`${JSON.stringify({
  event: "production_northstar_historical_sources_verified",
  tenant_id: tenantId,
  source_count: rows.length,
  statuses: [...new Set(rows.map((row) => row.status))],
  freshness: [...new Set(rows.map((row) => row.freshness))],
  live_connection: false,
  sync_disabled: true,
  credential_rows: 0,
  ledger_unchanged: true,
  ledger_counts: {
    accounts: ledger.accounts,
    counterparties: ledger.counterparties,
    transactions: ledger.transactions,
    obligations: ledger.obligations,
    invoices: ledger.invoices,
  },
  names,
})}\n`);
'

printf '%s\n' "production_northstar_historical_sources_completed"
