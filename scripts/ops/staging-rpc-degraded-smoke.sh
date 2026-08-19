#!/usr/bin/env bash
# Staging-only acceptance smoke for degraded Base RPC startup. This script
# never edits .env.staging: it uses a temporary compose env file and restores
# the normal API and worker containers before exiting.

set -euo pipefail

repo_dir="${REPO_DIR:?REPO_DIR is required}"
env_file="${VM_ENV_FILE:?VM_ENV_FILE is required}"
compose_project="${COMPOSE_PROJECT:?COMPOSE_PROJECT is required}"
api_base="${API_BASE:?API_BASE is required}"

cd "$repo_dir"
test_env="$(mktemp)"
restored=0
create_body=""
session_body=""

compose() {
  BRAIN_ENV_FILE="$1" docker compose -p "$compose_project" --env-file "$1" \
    -f docker-compose.prod.yml -f docker-compose.caddy.yml --profile agents "${@:2}"
}

health_field() {
  local field="$1"
  curl -fsS --max-time 15 "$api_base/health" | docker exec -i brain-prod-api node -e '
    const field = process.argv[1];
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(body);
      const value = field === "status" ? parsed?.onchain_rpc?.status : parsed?.commit;
      if (typeof value !== "string") process.exit(1);
      process.stdout.write(value);
    });
  ' "$field"
}

restore() {
  if [[ "$restored" -eq 1 ]]; then
    return
  fi
  restored=1
  echo "restoring_staging_rpc_config=started"
  compose "$env_file" up -d --force-recreate --no-deps --no-build api worker
  for _ in $(seq 1 18); do
    if [[ "$(health_field status 2>/dev/null || true)" == "ready" ]]; then
      echo "restoring_staging_rpc_config=complete"
      return
    fi
    sleep 5
  done
  echo "restoring_staging_rpc_config=failed" >&2
  return 1
}

cleanup() {
  local code="$?"
  trap - EXIT
  rm -f "$test_env" "$create_body" "$session_body"
  restore || code=1
  exit "$code"
}
trap cleanup EXIT

cp "$env_file" "$test_env"
printf '\nBASE_RPC_URL=http://127.0.0.1:1\nBASE_RPC_FALLBACK_URLS=\n' >> "$test_env"

echo "degraded_recreate=started"
compose "$test_env" up -d --force-recreate --no-deps --no-build api worker
for _ in $(seq 1 18); do
  if [[ "$(health_field status 2>/dev/null || true)" == "degraded" ]]; then
    break
  fi
  sleep 5
done
if [[ "$(health_field status)" != "degraded" ]]; then
  echo "api did not report degraded Base RPC readiness" >&2
  exit 1
fi
echo "degraded_health_status=degraded"

set -a
. "./$env_file"
set +a
if [[ -z "${BRAIN_PLATFORM_SERVICE_SECRET:-}" ]]; then
  echo "BRAIN_PLATFORM_SERVICE_SECRET is not configured" >&2
  exit 1
fi

identity_suffix="$(docker exec brain-prod-api node -e 'process.stdout.write(require("node:crypto").randomUUID().replace(/-/g, ""))')"
external_ref="rpc-degraded-smoke:${identity_suffix}"
create_body="$(mktemp)"
session_body="$(mktemp)"

create_status="$(
  curl -sS --max-time 30 -o "$create_body" -w '%{http_code}' \
    -X POST "$api_base/v1/tenants" \
    -H 'Content-Type: application/json' \
    -H "X-Platform-Service-Auth: ${BRAIN_PLATFORM_SERVICE_SECRET}" \
    --data "{\"company_name\":\"RPC degraded staging smoke\",\"founder\":{\"email\":\"rpc-degraded-${identity_suffix}@brain.invalid\",\"display_name\":\"RPC Degraded Smoke\"},\"founder_external_ref\":\"${external_ref}\"}"
)"
if [[ "$create_status" != "201" ]]; then
  echo "tenant_create_status=$create_status" >&2
  exit 1
fi

session_status="$(
  curl -sS --max-time 30 -o "$session_body" -w '%{http_code}' \
    -X POST "$api_base/v1/sessions" \
    -H 'Content-Type: application/json' \
    -H "X-Platform-Service-Auth: ${BRAIN_PLATFORM_SERVICE_SECRET}" \
    --data "{\"external_ref\":\"${external_ref}\",\"scopes\":[\"ledger:read\",\"wiki:read\"]}"
)"
if [[ "$session_status" != "200" ]]; then
  echo "session_exchange_status=$session_status" >&2
  exit 1
fi
token="$(cat "$session_body" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const token = JSON.parse(body)?.token;
    if (typeof token !== "string" || token === "") process.exit(1);
    process.stdout.write(token);
  });
')"

ledger_status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" "$api_base/v1/ledger/accounts")"
wiki_status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
  -X POST "$api_base/v1/wiki/question" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${token}" \
  --data '{"question":"What Ledger records are available?"}')"

if [[ "$ledger_status" != "200" || "$wiki_status" != "200" ]]; then
  echo "ledger_status=$ledger_status wiki_status=$wiki_status" >&2
  exit 1
fi
echo "tenant_create_status=$create_status"
echo "session_exchange_status=$session_status"
echo "ledger_status=$ledger_status"
echo "wiki_status=$wiki_status"
