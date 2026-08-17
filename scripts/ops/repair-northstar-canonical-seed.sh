#!/usr/bin/env bash
set -euo pipefail

readonly tenant_id='tnt_01M08J9B75QH08MCVA884N57VB'
readonly script_path='scripts/ops/repair-northstar-canonical-seed.mjs'
readonly container_script_path='services/api/ops-repair-northstar-canonical-seed.mjs'
readonly validator_path='scripts/ops/validate-northstar-staging.mjs'

mode="${MODE:-report}"
confirmation="${CONFIRMATION:-}"

if [[ "$mode" != 'report' && "$mode" != 'apply' ]]; then
  echo 'mode must be report or apply' >&2
  exit 1
fi
if [[ "$mode" == 'apply' && "$confirmation" != 'REPAIR_CANONICAL_NORTHSTAR_SEED' ]]; then
  echo 'apply requires the exact confirmation string' >&2
  exit 1
fi

cd ~/brain-core
if [[ ! -f "$script_path" || ! -f "$validator_path" ]]; then
  echo 'Northstar repair scripts are not present on the staging VM' >&2
  exit 1
fi

run_repair=()
if [[ "$mode" == 'apply' ]]; then
  run_repair+=(--apply)
fi

docker compose -p brain-staging --env-file .env.staging -f docker-compose.prod.yml run --rm --no-deps \
  -v "$PWD/$script_path:/app/$container_script_path:ro" \
  migrate node "$container_script_path" "${run_repair[@]}"

if [[ "$mode" == 'report' ]]; then
  echo 'northstar_canonical_repair_report_completed'
  exit 0
fi

docker compose -p brain-staging --env-file .env.staging -f docker-compose.prod.yml run --rm --no-deps \
  -e "BRAIN_TENANT_ID=$tenant_id" \
  -v "$PWD/$validator_path:/app/services/api/validate-northstar-staging.mjs:ro" \
  migrate node services/api/validate-northstar-staging.mjs

echo 'northstar_canonical_repair_apply_completed'
