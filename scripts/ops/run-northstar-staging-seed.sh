#!/usr/bin/env bash
set -euo pipefail

: "${VM_ENV_FILE:?VM_ENV_FILE is required}"
: "${API_BASE:?API_BASE is required}"
: "${VALIDATOR_PATH:?VALIDATOR_PATH is required}"

cd ~/brain-core
set -a
. "./${VM_ENV_FILE}"
set +a
: "${BRAIN_PLATFORM_SERVICE_SECRET:?BRAIN_PLATFORM_SERVICE_SECRET is required}"

payload="$(docker exec brain-prod-api node -e '
  const { randomUUID } = require("node:crypto");
  const suffix = randomUUID().replace(/-/g, "");
  process.stdout.write(JSON.stringify({
    company_name: "Northstar Labs, Inc. staging validation",
    founder: { email: `northstar-phase4+${suffix}@brain.invalid`, display_name: "Northstar Validation" },
    founder_external_ref: `northstar-phase4:${suffix}`,
    demo_seed: false,
  }));
')"
response="$(printf '%s' "$payload" | curl -fsS -X POST "$API_BASE/v1/tenants" -H "X-Platform-Service-Auth: ${BRAIN_PLATFORM_SERVICE_SECRET}" -H 'Content-Type: application/json' --data-binary @-)"
tenant_id="$(printf '%s' "$response" | docker exec -i brain-prod-api node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const v=JSON.parse(b);if(typeof v.tenant_id!=="string"||typeof v.member?.id!=="string")process.exit(1);process.stdout.write(v.tenant_id)})')"
actor_id="$(printf '%s' "$response" | docker exec -i brain-prod-api node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const v=JSON.parse(b);if(typeof v.member?.id!=="string")process.exit(1);process.stdout.write(v.member.id)})')"

printf 'northstar_phase4_tenant_id=%s\n' "$tenant_id"
docker exec -e BRAIN_TENANT_ID="$tenant_id" -e BRAIN_ACTOR="$actor_id" brain-prod-api node tools/seed-northstar-demo/dist/cli.js
docker cp "$VALIDATOR_PATH" brain-prod-api:/app/validate-northstar-staging.mjs
docker exec -e BRAIN_TENANT_ID="$tenant_id" brain-prod-api node /app/validate-northstar-staging.mjs
