#!/usr/bin/env bash
set -euo pipefail

: "${API_BASE:?API_BASE is required}"
: "${VM_ENV_FILE:?VM_ENV_FILE is required}"

readonly expected_api_base="https://api.brain.fi"
readonly expected_env_file=".env.prod"

if [[ "$API_BASE" != "$expected_api_base" ]]; then
  echo "production_preflight_failed=unexpected_api_base" >&2
  exit 1
fi
if [[ "$VM_ENV_FILE" != "$expected_env_file" ]]; then
  echo "production_preflight_failed=unexpected_env_file" >&2
  exit 1
fi

cd ~/brain-core
health="$(curl -fsS --connect-timeout 10 --max-time 30 "$API_BASE/health")"
health_commit="$(printf '%s' "$health" | docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  if (value.ok !== true || !/^[0-9a-f]{40}$/.test(value.commit ?? "")) process.exit(1);
  process.stdout.write(value.commit);
});
')"

runtime="$(docker exec brain-prod-api node -e '
const raw = process.env.BRAIN_RESOLVER_DB_URL;
if (!raw) process.exit(1);
const url = new URL(raw);
process.stdout.write(JSON.stringify({
  git_sha: process.env.GIT_SHA ?? null,
  node_env: process.env.NODE_ENV ?? null,
  resolver_hostname: url.hostname,
  resolver_port: url.port || null,
  resolver_database: url.pathname.replace(/^\//, ""),
}));
')"

printf '%s' "$runtime" | docker exec -i \
  -e EXPECTED_HEALTH_COMMIT="$health_commit" \
  brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  const expectedCommit = process.env.EXPECTED_HEALTH_COMMIT;
  const ok = value.git_sha === expectedCommit &&
    value.node_env === "production" &&
    value.resolver_hostname === "postgres" &&
    value.resolver_port === "5432" &&
    value.resolver_database === "brain";
  process.exit(ok ? 0 : 1);
});
'

database="$(docker exec brain-prod-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U brain -d brain -c "
  BEGIN TRANSACTION READ ONLY;
  SELECT json_build_object(
    'database', current_database(),
    'database_user', current_user,
    'in_recovery', pg_is_in_recovery()
  )::text;
  COMMIT;" | tr -d '\r' | sed '/^$/d')"

printf '%s' "$database" | docker exec -i brain-prod-api node -e '
let text = "";
process.stdin.on("data", (chunk) => text += chunk);
process.stdin.on("end", () => {
  const value = JSON.parse(text);
  process.exit(value.database === "brain" && value.in_recovery === false ? 0 : 1);
});
'

docker exec \
  -e HEALTH_COMMIT="$health_commit" \
  -e RUNTIME_JSON="$runtime" \
  -e DATABASE_JSON="$database" \
  brain-prod-api node -e '
const runtime = JSON.parse(process.env.RUNTIME_JSON);
const database = JSON.parse(process.env.DATABASE_JSON);
process.stdout.write(`${JSON.stringify({
  event: "true_production_preflight",
  api_base: "https://api.brain.fi",
  vm_env_file: ".env.prod",
  health_commit: process.env.HEALTH_COMMIT,
  runtime,
  database,
  passed: true,
})}\n`);
'

printf '%s\n' "true_production_preflight_completed"
