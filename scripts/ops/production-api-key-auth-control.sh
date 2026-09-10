#!/usr/bin/env bash
set -euo pipefail

readonly API_BASE="https://api.brain.fi"
readonly HEALTH_URL="${API_BASE}/health"
readonly VM_ENV_FILE=".env.prod"
readonly API_ENV_FILE=".env.api.prod"
readonly API_MINIO_CREDENTIAL_FILE=".env.minio-api"
readonly COMPOSE_PROJECT="brain-prod"
readonly API_CONTAINER="brain-prod-api"
readonly POSTGRES_CONTAINER="brain-prod-postgres"
readonly REDIS_CONTAINER="brain-prod-redis"

usage() {
  echo "Usage: $0 inspect|enable|disable [mode-0600-enable-patch]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

action="$1"
patch_file="${2:-}"
case "$action" in
  inspect|enable|disable) ;;
  *) usage; exit 2 ;;
esac
if [[ "$action" == "enable" && -z "$patch_file" ]]; then
  usage
  exit 2
fi
if [[ "$action" != "enable" && -n "$patch_file" ]]; then
  usage
  exit 2
fi

cd ~/brain-core
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env API_BASE="$API_BASE" VM_ENV_FILE="$VM_ENV_FILE" \
  bash "$script_dir/assert-true-production.sh"

if [[ ! -f "$VM_ENV_FILE" || -L "$VM_ENV_FILE" \
  || ! -f "$API_ENV_FILE" || -L "$API_ENV_FILE" \
  || ! -f "$API_MINIO_CREDENTIAL_FILE" || -L "$API_MINIO_CREDENTIAL_FILE" ]]; then
  echo "production_api_key_control_failed=unsafe_env_file" >&2
  exit 1
fi

compose_files=(-f docker-compose.prod.yml)
if [[ -f docker-compose.caddy.yml ]]; then
  compose_files+=(-f docker-compose.caddy.yml)
fi

report_env_states() {
  local path="$1"
  local label="$2"
  python3 - "$path" "$label" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
label = sys.argv[2]
keys = (
    "BRAIN_API_KEY_AUTH_ENABLED",
    "BRAIN_API_KEY_PEPPER",
    "BRAIN_EDGE_RATE_LIMIT",
    "BRAIN_API_KEY_RATE_LIMIT_TIMEOUT_MS",
)
states = {}
lines = path.read_text().splitlines()
for key in keys:
    values = [
        line.split("=", 1)[1].strip()
        for line in lines
        if not line.lstrip().startswith("#")
        and "=" in line
        and line.split("=", 1)[0].strip() == key
    ]
    if not values:
        state = "absent"
    elif values[-1].strip("\"'") == "":
        state = "present-empty"
    else:
        state = "present-nonempty"
    states[key] = {"state": state, "active_occurrences": len(values)}
print(json.dumps({"event": "production_api_key_env_states", "file": label, "variables": states}, sort_keys=True))
PY
}

report_commercial_flag_states() {
  local path="$1"
  local label="$2"
  python3 - "$path" "$label" <<'PY'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])
label = sys.argv[2]
keys = (
    "BRAIN_COMMERCIAL_CATALOG_ENABLED",
    "BRAIN_PRODUCTION_GRADUATION_ENABLED",
    "BRAIN_COMMERCIAL_SHADOW_ENABLED",
    "BRAIN_ENTITY_SCOPE_ENABLED",
    "BRAIN_AGENT_CAPACITY_ENABLED",
    "BRAIN_EXECUTION_LIMITS_ENABLED",
    "BRAIN_STRIPE_BILLING_ENABLED",
    "BRAIN_X402_PAYMENTS_ENABLED",
    "BRAIN_OUTCOME_FEES_ENABLED",
    "BRAIN_MOVEMENT_FEES_ENABLED",
)
states = {}
passed = True
lines = path.read_text().splitlines()
for key in keys:
    values = [
        line.split("=", 1)[1].strip().strip("\"'").lower()
        for line in lines
        if not line.lstrip().startswith("#")
        and "=" in line
        and line.split("=", 1)[0].strip() == key
    ]
    if not values:
        state = "absent-default-false"
        enabled = False
    elif values[-1] == "false":
        state = "present-false"
        enabled = False
    elif values[-1] == "true":
        state = "present-true"
        enabled = True
        passed = False
    else:
        state = "present-invalid"
        enabled = None
        passed = False
    states[key] = {
        "state": state,
        "enabled": enabled,
        "active_occurrences": len(values),
    }
print(json.dumps({
    "event": "production_commercial_flag_states",
    "file": label,
    "flags": states,
    "all_effectively_false": passed,
}, sort_keys=True))
if not passed:
    raise SystemExit("commercial feature flags are not all effectively false")
PY
}

require_scoped_api_credential() {
  if ! python3 - "$VM_ENV_FILE" "$API_MINIO_CREDENTIAL_FILE" <<'PY'
from pathlib import Path
import stat
import sys

def values(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        if line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip("\"'")
    return result

source = values(sys.argv[1])
credential = values(sys.argv[2])
if stat.S_IMODE(Path(sys.argv[2]).stat().st_mode) != 0o600:
    raise SystemExit("scoped API MinIO credential file is not mode 0600")
if credential.get("MINIO_API_ACCESS_KEY_ID") != "brain-api":
    raise SystemExit("scoped API MinIO identity is not brain-api")
secret = credential.get("MINIO_API_SECRET_ACCESS_KEY", "")
if not secret or secret == source.get("MINIO_ROOT_PASSWORD"):
    raise SystemExit("scoped API MinIO secret is missing or root-backed")
PY
  then
    echo '{"event":"production_api_scoped_minio_state","identity":null,"root_backed":null,"healthy":false}'
    return 1
  fi
  echo '{"event":"production_api_scoped_minio_state","identity":"brain-api","root_backed":false}'
}

report_runtime_state() {
  docker exec "$API_CONTAINER" node -e '
const enabled = (process.env.BRAIN_API_KEY_AUTH_ENABLED ?? "false").toLowerCase() === "true";
const commercialKeys = [
  "BRAIN_COMMERCIAL_CATALOG_ENABLED",
  "BRAIN_PRODUCTION_GRADUATION_ENABLED",
  "BRAIN_COMMERCIAL_SHADOW_ENABLED",
  "BRAIN_ENTITY_SCOPE_ENABLED",
  "BRAIN_AGENT_CAPACITY_ENABLED",
  "BRAIN_EXECUTION_LIMITS_ENABLED",
  "BRAIN_STRIPE_BILLING_ENABLED",
  "BRAIN_X402_PAYMENTS_ENABLED",
  "BRAIN_OUTCOME_FEES_ENABLED",
  "BRAIN_MOVEMENT_FEES_ENABLED",
];
const commercialFlags = Object.fromEntries(commercialKeys.map((key) => [
  key,
  {
    present: Object.hasOwn(process.env, key),
    enabled: (process.env[key] ?? "false").toLowerCase() === "true",
  },
]));
const commercialFlagsAllFalse = Object.values(commercialFlags).every(({ enabled: value }) => !value);
process.stdout.write(JSON.stringify({
  event: "production_api_key_runtime_state",
  enabled,
  pepper_present: Boolean(process.env.BRAIN_API_KEY_PEPPER),
  edge_rate_limit_present: Boolean(process.env.BRAIN_EDGE_RATE_LIMIT),
  timeout_present: Boolean(process.env.BRAIN_API_KEY_RATE_LIMIT_TIMEOUT_MS),
  commercial_flags: commercialFlags,
  commercial_flags_all_false: commercialFlagsAllFalse,
  git_sha: process.env.GIT_SHA ?? null,
}) + "\n");
process.exit(commercialFlagsAllFalse ? 0 : 1);
'
}

report_database_state() {
  docker exec "$POSTGRES_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain <<'SQL'
BEGIN TRANSACTION READ ONLY;
WITH role_names(role_name) AS (
  VALUES
      ('brain_app'), ('brain_privileged'), ('brain_wiki_reader'),
      ('brain_mcp_reader'), ('brain_raw_worker'), ('brain_canonical_projector'),
      ('brain_ledger_projector'), ('brain_execution_worker'),
      ('brain_audit_verifier'), ('brain_audit_publisher'), ('brain_resolver'),
      ('brain_tenant_deletion'), ('brain_surface_gateway'),
      ('brain_surface_audit_writer'), ('brain_auth'), ('brain_auth_audit_writer')
), role_grants AS (
  SELECT role_names.role_name,
         pg_roles.oid IS NOT NULL AS role_present,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'SELECT'), FALSE) AS can_select,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'INSERT'), FALSE) AS can_insert,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'UPDATE'), FALSE) AS can_update,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'DELETE'), FALSE) AS can_delete,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'TRUNCATE'), FALSE) AS can_truncate
    FROM role_names
    LEFT JOIN pg_roles ON pg_roles.rolname = role_names.role_name
), role_contract AS (
  SELECT bool_and(
    CASE
      WHEN role_name = 'brain_app' THEN
        role_present AND can_select AND can_insert AND can_update AND can_delete AND NOT can_truncate
      WHEN role_name IN ('brain_privileged', 'brain_wiki_reader', 'brain_resolver') THEN
        role_present AND can_select AND NOT can_insert AND NOT can_update AND NOT can_delete AND NOT can_truncate
      WHEN role_name = 'brain_tenant_deletion' THEN
        role_present AND can_select AND NOT can_insert AND NOT can_update AND can_delete AND NOT can_truncate
      ELSE
        role_present AND NOT can_select AND NOT can_insert AND NOT can_update AND NOT can_delete AND NOT can_truncate
    END
  ) AS matches
  FROM role_grants
)
SELECT json_build_object(
  'event', 'production_api_key_database_state',
  'api_keys_table_present', to_regclass('public.api_keys') IS NOT NULL,
  'migration_0017_shape_present', (
    SELECT count(*) = 8
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'api_keys'
       AND column_name = ANY(ARRAY[
         'id', 'tenant_id', 'environment', 'scopes', 'key_prefix', 'key_last4',
         'hashed_secret', 'rotated_from_id'
       ])
  ),
  'rls_enabled', COALESCE((
    SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.api_keys')
  ), FALSE),
  'rls_forced', COALESCE((
    SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.api_keys')
  ), FALSE),
  'tenant_policy_count', (
    SELECT count(*) FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'api_keys'
  ),
  'role_grants', (
    SELECT json_object_agg(
      role_name,
      json_build_object(
        'present', role_present,
        'select', can_select,
        'insert', can_insert,
        'update', can_update,
        'delete', can_delete,
        'truncate', can_truncate
      ) ORDER BY role_name
    )
    FROM role_grants
  ),
  'role_grants_match', (SELECT matches FROM role_contract)
)::text;
COMMIT;
SQL
}

require_database_state() {
  state="$(docker exec "$POSTGRES_CONTAINER" psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain <<'SQL'
BEGIN TRANSACTION READ ONLY;
WITH role_names(role_name) AS (
  VALUES
      ('brain_app'), ('brain_privileged'), ('brain_wiki_reader'),
      ('brain_mcp_reader'), ('brain_raw_worker'), ('brain_canonical_projector'),
      ('brain_ledger_projector'), ('brain_execution_worker'),
      ('brain_audit_verifier'), ('brain_audit_publisher'), ('brain_resolver'),
      ('brain_tenant_deletion'), ('brain_surface_gateway'),
      ('brain_surface_audit_writer'), ('brain_auth'), ('brain_auth_audit_writer')
), role_grants AS (
  SELECT role_names.role_name,
         pg_roles.oid IS NOT NULL AS role_present,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'SELECT'), FALSE) AS can_select,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'INSERT'), FALSE) AS can_insert,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'UPDATE'), FALSE) AS can_update,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'DELETE'), FALSE) AS can_delete,
         COALESCE(has_table_privilege(pg_roles.oid, to_regclass('public.api_keys'), 'TRUNCATE'), FALSE) AS can_truncate
    FROM role_names
    LEFT JOIN pg_roles ON pg_roles.rolname = role_names.role_name
), role_contract AS (
  SELECT bool_and(
    CASE
      WHEN role_name = 'brain_app' THEN
        role_present AND can_select AND can_insert AND can_update AND can_delete AND NOT can_truncate
      WHEN role_name IN ('brain_privileged', 'brain_wiki_reader', 'brain_resolver') THEN
        role_present AND can_select AND NOT can_insert AND NOT can_update AND NOT can_delete AND NOT can_truncate
      WHEN role_name = 'brain_tenant_deletion' THEN
        role_present AND can_select AND NOT can_insert AND NOT can_update AND can_delete AND NOT can_truncate
      ELSE
        role_present AND NOT can_select AND NOT can_insert AND NOT can_update AND NOT can_delete AND NOT can_truncate
    END
  ) AS matches
  FROM role_grants
)
SELECT (
  to_regclass('public.api_keys') IS NOT NULL
  AND (SELECT count(*) = 8 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'api_keys'
          AND column_name = ANY(ARRAY[
            'id', 'tenant_id', 'environment', 'scopes', 'key_prefix', 'key_last4',
            'hashed_secret', 'rotated_from_id'
          ]))
  AND COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.api_keys')), FALSE)
  AND COALESCE((SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.api_keys')), FALSE)
  AND (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'api_keys') >= 1
  AND (SELECT matches FROM role_contract)
)::text;
COMMIT;
SQL
)"
  [[ "$(printf '%s' "$state" | tr -d '\r[:space:]')" == "true" ]]
}

require_redis() {
  local response
  if response="$(docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null)" \
    && [[ "$(printf '%s' "$response" | tr -d '\r[:space:]')" == "PONG" ]]; then
    echo '{"event":"production_api_key_redis_state","healthy":true}'
    return 0
  fi
  echo '{"event":"production_api_key_redis_state","healthy":false}'
  return 1
}

inspect() {
  local passed=true
  report_env_states "$VM_ENV_FILE" source
  report_env_states "$API_ENV_FILE" api-runtime
  if ! report_commercial_flag_states "$VM_ENV_FILE" source; then passed=false; fi
  if ! report_commercial_flag_states "$API_ENV_FILE" api-runtime; then passed=false; fi
  if ! report_runtime_state; then passed=false; fi
  if ! report_database_state; then passed=false; fi
  if ! require_database_state; then passed=false; fi
  if ! require_redis; then passed=false; fi
  if ! require_scoped_api_credential; then passed=false; fi
  if [[ "$passed" != "true" ]]; then
    echo "production_api_key_inspection=failed" >&2
    return 1
  fi
  echo "production_api_key_inspection=passed"
}

validate_enable_patch() {
  if [[ ! -f "$patch_file" || -L "$patch_file" ]]; then
    echo "production_api_key_control_failed=unsafe_patch_file" >&2
    exit 1
  fi
  mode="$(stat -c '%a' "$patch_file")"
  if [[ "$mode" != "600" ]]; then
    echo "production_api_key_control_failed=patch_mode_not_0600" >&2
    exit 1
  fi
  python3 - "$patch_file" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
expected = {
    "BRAIN_API_KEY_AUTH_ENABLED": "true",
    "BRAIN_EDGE_RATE_LIMIT": "100000",
    "BRAIN_API_KEY_RATE_LIMIT_TIMEOUT_MS": "2000",
}
values = {}
for line in path.read_text().splitlines():
    if not line or line.startswith("#") or "=" not in line:
        raise SystemExit("enable patch contains an invalid line")
    key, value = line.split("=", 1)
    if key in values:
        raise SystemExit("enable patch contains duplicate variables")
    values[key] = value
if set(values) != set(expected) | {"BRAIN_API_KEY_PEPPER"}:
    raise SystemExit("enable patch variable set is not fixed")
if any(values[key] != value for key, value in expected.items()):
    raise SystemExit("enable patch fixed values do not match")
pepper = values["BRAIN_API_KEY_PEPPER"]
if len(pepper) < 64 or re.fullmatch(r"[A-Za-z0-9_-]+", pepper) is None:
    raise SystemExit("production pepper does not meet the 32-byte encoded minimum")
PY
}

atomic_upsert() {
  local source_file="$1"
  python3 - "$VM_ENV_FILE" "$source_file" <<'PY'
from pathlib import Path
import os
import stat
import sys
import tempfile

target = Path(sys.argv[1])
source = Path(sys.argv[2])
updates = {}
for line in source.read_text().splitlines():
    key, value = line.split("=", 1)
    updates[key] = value

lines = target.read_text().splitlines()
last = {}
for index, line in enumerate(lines):
    if line.lstrip().startswith("#") or "=" not in line:
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        last[key] = index

result = []
written = set()
for index, line in enumerate(lines):
    if line.lstrip().startswith("#") or "=" not in line:
        result.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key not in updates:
        result.append(line)
    elif last[key] == index:
        result.append(f"{key}={updates[key]}")
        written.add(key)
for key, value in updates.items():
    if key not in written:
        result.append(f"{key}={value}")

metadata = target.stat()
fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.api-key-", dir=target.parent)
temporary = Path(temporary_name)
try:
    with os.fdopen(fd, "w") as handle:
        handle.write("\n".join(result) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
    os.chown(temporary, metadata.st_uid, metadata.st_gid)
    os.replace(temporary, target)
finally:
    temporary.unlink(missing_ok=True)
PY
}

recreate_api() {
  docker compose -p "$COMPOSE_PROJECT" --env-file "$VM_ENV_FILE" \
    "${compose_files[@]}" --profile agents up -d --no-deps --no-build \
    --force-recreate api
}

render_api_env() {
  require_scoped_api_credential
  bash "$script_dir/prepare-minio-api-env.sh" \
    --env "$VM_ENV_FILE" \
    --credentials "$API_MINIO_CREDENTIAL_FILE" \
    --output "$API_ENV_FILE"
}

wait_for_api() {
  local expected_enabled="$1"
  for _ in $(seq 1 24); do
    health="$(docker inspect --format '{{.State.Health.Status}}' "$API_CONTAINER" 2>/dev/null || true)"
    runtime="$(docker exec -e EXPECTED_ENABLED="$expected_enabled" "$API_CONTAINER" node -e '
const expected = process.env.EXPECTED_ENABLED === "true";
const actual = (process.env.BRAIN_API_KEY_AUTH_ENABLED ?? "false").toLowerCase() === "true";
const pepper = Boolean(process.env.BRAIN_API_KEY_PEPPER);
process.exit(actual === expected && (!expected || pepper) ? 0 : 1);
' 2>/dev/null && echo ready || true)"
    if [[ "$health" == "healthy" && "$runtime" == "ready" ]] \
      && curl -fsS --connect-timeout 5 --max-time 10 "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

verify_runtime_expected() {
  local expected_enabled="$1"
  docker exec -e EXPECTED_ENABLED="$expected_enabled" "$API_CONTAINER" node -e '
const expected = process.env.EXPECTED_ENABLED === "true";
const enabled = (process.env.BRAIN_API_KEY_AUTH_ENABLED ?? "false").toLowerCase() === "true";
const pepperPresent = Boolean(process.env.BRAIN_API_KEY_PEPPER);
const rateLimit = process.env.BRAIN_EDGE_RATE_LIMIT ?? null;
const timeout = process.env.BRAIN_API_KEY_RATE_LIMIT_TIMEOUT_MS ?? null;
const ok = enabled === expected && (!expected || pepperPresent) &&
  (!expected || rateLimit === "100000") && (!expected || timeout === "2000");
process.stdout.write(JSON.stringify({
  event: "production_api_key_runtime_verification",
  enabled,
  pepper_present: pepperPresent,
  fixed_rate_limit: rateLimit === "100000",
  fixed_timeout: timeout === "2000",
  passed: ok,
}) + "\n");
process.exit(ok ? 0 : 1);
'
  env API_BASE="$API_BASE" VM_ENV_FILE="$VM_ENV_FILE" \
    bash "$script_dir/assert-true-production.sh"
}

mutate() {
  local expected_enabled backup update_file previous_enabled rc rollback_rc
  expected_enabled="$1"
  backup="${VM_ENV_FILE}.bak-api-key-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  update_file="$2"
  previous_enabled="$(python3 - "$VM_ENV_FILE" <<'PY'
from pathlib import Path
import sys

value = "false"
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.lstrip().startswith("#") or "=" not in line:
        continue
    key, candidate = line.split("=", 1)
    if key.strip() == "BRAIN_API_KEY_AUTH_ENABLED":
        value = candidate.strip().strip("\"'").lower()
print("true" if value == "true" else "false")
PY
)"
  cp --preserve=mode,ownership,timestamps "$VM_ENV_FILE" "$backup"

  set +e
  atomic_upsert "$update_file" \
    && bash "$script_dir/check-required-compose-secrets.sh" \
      --compose docker-compose.prod.yml --env "$VM_ENV_FILE" \
    && render_api_env \
    && recreate_api \
    && wait_for_api "$expected_enabled" \
    && verify_runtime_expected "$expected_enabled"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    cp --preserve=mode,ownership,timestamps "$backup" "$VM_ENV_FILE"
    set +e
    bash "$script_dir/check-required-compose-secrets.sh" \
      --compose docker-compose.prod.yml --env "$VM_ENV_FILE" \
      && render_api_env \
      && recreate_api \
      && wait_for_api "$previous_enabled" \
      && env API_BASE="$API_BASE" VM_ENV_FILE="$VM_ENV_FILE" \
        bash "$script_dir/assert-true-production.sh"
    rollback_rc=$?
    set -e
    if [[ "$rollback_rc" -ne 0 ]]; then
      echo "production_api_key_control_rollback=failed" >&2
      return 1
    fi
    echo "production_api_key_control_rollback=restored_and_verified" >&2
    return "$rc"
  fi
  echo "production_api_key_control_backup=$backup"
}

inspect
if [[ "$action" == "inspect" ]]; then
  exit 0
fi

if [[ "$action" == "enable" ]]; then
  validate_enable_patch
  mutate true "$patch_file"
  echo "production_api_key_auth_state=enabled"
  exit 0
fi

disable_patch="$(mktemp)"
trap 'rm -f "$disable_patch"' EXIT
chmod 600 "$disable_patch"
printf '%s\n' 'BRAIN_API_KEY_AUTH_ENABLED=false' > "$disable_patch"
mutate false "$disable_patch"
echo "production_api_key_auth_state=disabled"
