#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-}"

if [[ "$env_file" != ".env.prod" ]]; then
  echo "anchor_fee_floor_status=invalid_env_file"
  exit 2
fi

if [[ ! -f "$env_file" ]]; then
  echo "anchor_fee_floor_status=env_file_missing"
  exit 1
fi

priority_key="BRAIN_ONCHAIN_MIN_PRIORITY_FEE_GWEI"
max_key="BRAIN_ONCHAIN_MIN_MAX_FEE_GWEI"
priority_value="0.025"
max_value="0.20"

priority_count="$(grep -Ec "^${priority_key}=" "$env_file" || true)"
max_count="$(grep -Ec "^${max_key}=" "$env_file" || true)"
if [[ "$priority_count" -gt 1 || "$max_count" -gt 1 ]]; then
  echo "anchor_fee_floor_status=duplicate_env_entries"
  exit 1
fi

backup="${env_file}.bak-anchor-fee-floor-$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp "${env_file}.tmp.XXXXXX")"
chmod --reference="$env_file" "$tmp"
cp "$env_file" "$backup"

awk \
  -v priority_key="$priority_key" \
  -v priority_value="$priority_value" \
  -v max_key="$max_key" \
  -v max_value="$max_value" '
  $0 ~ "^" priority_key "=" {
    print priority_key "=" priority_value
    priority_seen = 1
    next
  }
  $0 ~ "^" max_key "=" {
    print max_key "=" max_value
    max_seen = 1
    next
  }
  { print }
  END {
    if (!priority_seen) print priority_key "=" priority_value
    if (!max_seen) print max_key "=" max_value
  }
' "$env_file" > "$tmp"
mv "$tmp" "$env_file"

compose_files='-f docker-compose.prod.yml'
if [[ -f docker-compose.caddy.yml ]]; then
  compose_files="$compose_files -f docker-compose.caddy.yml"
fi
docker compose -p brain-prod --env-file "$env_file" $compose_files --profile agents \
  up -d --no-deps --no-build --force-recreate worker

for _ in $(seq 1 12); do
  if [[ "$(docker inspect --format '{{.State.Running}}' brain-prod-worker 2>/dev/null || true)" == "true" ]]; then
    break
  fi
  sleep 5
done

if [[ "$(docker inspect --format '{{.State.Running}}' brain-prod-worker 2>/dev/null || true)" != "true" ]]; then
  echo "anchor_fee_floor_status=worker_not_running"
  exit 1
fi

actual_priority="$(docker exec brain-prod-worker printenv "$priority_key")"
actual_max="$(docker exec brain-prod-worker printenv "$max_key")"
if [[ "$actual_priority" != "$priority_value" || "$actual_max" != "$max_value" ]]; then
  echo "anchor_fee_floor_status=worker_env_mismatch"
  exit 1
fi

echo "anchor_fee_floor_status=applied"
echo "worker_${priority_key}=$actual_priority"
echo "worker_${max_key}=$actual_max"
echo "worker_git_sha=$(docker exec brain-prod-worker printenv GIT_SHA)"
echo "anchor_fee_floor_ops_complete=1"
