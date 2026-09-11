#!/usr/bin/env bash

set -euo pipefail

action="${1:-}"
if [[ "$action" != "heartbeat" && "$action" != "run" ]]; then
  echo "usage: run-commercial-shadow-scheduler.sh <heartbeat|run>" >&2
  exit 2
fi

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$repo_dir"
deployed_sha=$(curl -fsS https://api.brain.fi/health | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["commit"])')
[[ "$deployed_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "production health does not report an exact deployed SHA" >&2
  exit 1
}

API_BASE=https://api.brain.fi VM_ENV_FILE=.env.prod \
  bash scripts/ops/assert-true-production.sh >/dev/null

credential_dir="$repo_dir/.commercial-shadow-secrets"
if [[ -L "$credential_dir" ]]; then
  echo "commercial shadow credential directory must not be a symlink" >&2
  exit 1
fi
mkdir -p -m 0700 "$credential_dir"
chmod 0700 "$credential_dir"
credential_path=/run/brain-commercial-shadow/credentials.json
run_reference="systemd:${action}:$(date -u +%Y%m%dT%H%M%SZ)"
compose=(
  docker compose -p brain-prod --env-file .env.prod
  -f docker-compose.prod.yml --profile ops run --rm --no-deps
  -v "$credential_dir:/run/brain-commercial-shadow:ro"
  entitlement-operator node services/api/dist/commercial/shadow-daily-cli.js
)

if [[ "$action" == "heartbeat" ]]; then
  heartbeat_state=ready
  if systemctl is-failed --quiet brain-commercial-shadow-daily.service; then
    heartbeat_state=unhealthy
  fi
  "${compose[@]}" heartbeat --deployed-sha "$deployed_sha" \
    --run-reference "$run_reference" --credential-path "$credential_path" \
    --state "$heartbeat_state"
  if [[ "$heartbeat_state" == "unhealthy" ]]; then
    echo "commercial shadow daily service remains failed" >&2
    exit 1
  fi
  exit 0
fi

if ! "${compose[@]}" run --deployed-sha "$deployed_sha" \
  --run-reference "$run_reference" --credential-path "$credential_path"; then
  "${compose[@]}" heartbeat --deployed-sha "$deployed_sha" \
    --run-reference "$run_reference:failed" --credential-path "$credential_path" \
    --state unhealthy || true
  exit 1
fi
