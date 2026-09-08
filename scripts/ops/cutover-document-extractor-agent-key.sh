#!/usr/bin/env bash
# Enable agent-key exchange and cut over only the centrally deployed document
# extractor. Run on the target VM with a generated PDF fixture path.
set -euo pipefail

required=(EXPECTED_SHA VM_ENV_FILE COMPOSE_PROJECT AGENT_KEY_ENVIRONMENT FIXTURE_PATH)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "required_input_status=${name}:missing"; exit 1; }
done
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "expected_sha_status=invalid"; exit 1; }
[[ "$AGENT_KEY_ENVIRONMENT" == "test" || "$AGENT_KEY_ENVIRONMENT" == "live" ]] || {
  echo "agent_key_environment_status=invalid"
  exit 1
}
[[ -f "$VM_ENV_FILE" ]] || { echo "env_file_status=missing"; exit 1; }
[[ -f "$FIXTURE_PATH" ]] || { echo "fixture_status=missing"; exit 1; }

compose_files=(-f docker-compose.prod.yml)
[[ -f docker-compose.caddy.yml ]] && compose_files+=(-f docker-compose.caddy.yml)
compose=(docker compose -p "$COMPOSE_PROJECT" --env-file "$VM_ENV_FILE" "${compose_files[@]}")
credential_file=".env.agent-key-document-extractor-v1"
agents_auth_file=".env.agents-auth.prod"
rollback_needed=false
legacy_header_file=""
platform_header_file=""

read_value() {
  local key="$1"
  local file="${2:-$VM_ENV_FILE}"
  local line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}"
}

replace_or_append() {
  local key="$1"
  local value="$2"
  local file="$3"
  local tmp value_file
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  value_file="$(mktemp "${file}.value.XXXXXX")"
  chmod --reference="$file" "$tmp"
  chmod 600 "$value_file"
  printf '%s' "$value" > "$value_file"
  awk -v key="$key" -v value_file="$value_file" '
    BEGIN {
      getline value < value_file
      close(value_file)
      replaced = 0
    }
    $0 ~ "^" key "=" {
      if (replaced == 0) {
        print key "=" value
        replaced = 1
      }
      next
    }
    { print }
    END { if (replaced == 0) print key "=" value }
  ' "$file" > "$tmp"
  rm -f "$value_file"
  mv "$tmp" "$file"
}

cleanup() {
  local status=$?
  rm -f "$FIXTURE_PATH" "$legacy_header_file" "$platform_header_file"
  if [[ $status -ne 0 && "$rollback_needed" == true ]]; then
    echo "canary_status=failed_restoring_legacy_runtime" >&2
    replace_or_append BRAIN_AGENTS_AUTH_MODE legacy_jwt "$VM_ENV_FILE"
    bash scripts/ops/prepare-agents-auth-env.sh \
      --env "$VM_ENV_FILE" --credentials "$credential_file" --output "$agents_auth_file"
    "${compose[@]}" --profile agents up -d --no-deps --force-recreate agents >/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

wait_for_commit() {
  local url="$1"
  local label="$2"
  local body commit
  for _ in $(seq 1 20); do
    body="$(curl -s "$url" || true)"
    commit="$(printf '%s' "$body" | grep -o '"commit":"[^"]*"' | sed 's/.*:"//;s/"$//' || true)"
    if [[ "$commit" == "$EXPECTED_SHA" ]]; then
      echo "${label}_git_sha=$commit"
      return 0
    fi
    sleep 5
  done
  echo "${label}_commit_status=unexpected" >&2
  return 1
}

runtime_sha="$("${compose[@]}" --profile agents exec -T agents printenv GIT_SHA | tr -d '\r')"
[[ "$runtime_sha" == "$EXPECTED_SHA" ]] || { echo "agents_git_sha_status=unexpected"; exit 1; }
echo "agents_git_sha=$runtime_sha"

legacy_token="$("${compose[@]}" --profile agents exec -T agents printenv BRAIN_API_TOKEN | tr -d '\r')"
[[ -n "$legacy_token" ]] || { echo "legacy_runtime_credential_status=missing"; exit 1; }
"${compose[@]}" --profile agents exec -T agents /bin/sh -c \
  'test -z "${BRAIN_AGENT_API_KEY+x}"' || { echo "legacy_runtime_mode=ambiguous"; exit 1; }
echo "legacy_runtime_mode=confirmed"
source_token="$(read_value BRAIN_API_TOKEN || true)"
[[ -n "$source_token" ]] || { echo "legacy_source_credential_status=missing"; exit 1; }
runtime_hash="$(printf '%s' "$legacy_token" | sha256sum | cut -d' ' -f1)"
source_hash="$(printf '%s' "$source_token" | sha256sum | cut -d' ' -f1)"
[[ "$runtime_hash" == "$source_hash" ]] || { echo "legacy_runtime_source_match=false"; exit 1; }
echo "legacy_runtime_source_match=true"
legacy_header_file="$(mktemp /tmp/agent-canary-legacy-header.XXXXXX)"
chmod 600 "$legacy_header_file"
printf 'Authorization: Bearer %s\n' "$legacy_token" > "$legacy_header_file"

claims="$(printf '%s' "$legacy_token" | "${compose[@]}" exec -T api node -e '
  let value = "";
  process.stdin.on("data", chunk => { value += chunk; });
  process.stdin.on("end", () => {
    try {
      const part = value.trim().split(".")[1];
      const body = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
      if (!/^tnt_/.test(body.tenant_id ?? "") || !/^agent_/.test(body.sub ?? "")) process.exit(1);
      process.stdout.write(`${body.tenant_id}\t${body.sub}`);
    } catch { process.exit(1); }
  });
')"
tenant_id="${claims%%$'\t'*}"
agent_id="${claims#*$'\t'}"
unset legacy_token source_token
echo "canary_tenant_id=$tenant_id"
echo "canary_agent_id=$agent_id"

if [[ "$AGENT_KEY_ENVIRONMENT" == "test" ]]; then
  docker exec -i brain-prod-postgres psql -X -v ON_ERROR_STOP=1 -U brain -d brain \
    -v tenant_id="$tenant_id" -v agent_id="$agent_id" <<'SQL' >/dev/null
BEGIN;
INSERT INTO tenants (id, kind)
VALUES (:'tenant_id', 'demo')
ON CONFLICT (id) DO NOTHING;
INSERT INTO agents (id, tenant_id, kind, role, display_name, state, registered_at)
VALUES (
  :'agent_id', :'tenant_id', 'internal', 'document_extractor',
  'Document Extractor', 'active', now()
)
ON CONFLICT (id) DO NOTHING;
COMMIT;
SQL
  echo "staging_fixture_binding=created_or_preserved"
fi

binding="$(docker exec -i brain-prod-postgres psql -X -At -U brain -d brain \
  -v tenant_id="$tenant_id" -v agent_id="$agent_id" <<'SQL'
SELECT
  (EXISTS (SELECT 1 FROM tenants WHERE id = :'tenant_id'))::int,
  (EXISTS (
    SELECT 1 FROM agents
     WHERE id = :'agent_id' AND tenant_id = :'tenant_id'
       AND kind = 'internal' AND state = 'active'
  ))::int;
SQL
)"
[[ "$binding" == "1|1" ]] || {
  echo "agent_database_binding_status=missing_or_ineligible:$binding"
  exit 1
}
echo "agent_database_binding_status=active_internal"

inventory="$(docker exec -i brain-prod-postgres psql -X -At -U brain -d brain <<'SQL'
SELECT
  count(DISTINCT agent_id) FILTER (
    WHERE revoked_at IS NULL AND expires_at > now()
  ),
  count(DISTINCT tenant_id) FILTER (
    WHERE revoked_at IS NULL AND expires_at > now()
  )
FROM production_agent_tokens;
SQL
)"
echo "active_bff_legacy_agent_count=${inventory%%|*}"
echo "active_bff_legacy_tenant_count=${inventory#*|}"

pepper="$(read_value BRAIN_AGENT_API_KEY_PEPPER || true)"
if [[ -z "$pepper" ]]; then
  pepper="$(openssl rand -hex 32)"
  replace_or_append BRAIN_AGENT_API_KEY_PEPPER "$pepper" "$VM_ENV_FILE"
fi
api_key_pepper="$(read_value BRAIN_API_KEY_PEPPER || true)"
[[ -z "$api_key_pepper" || "$pepper" != "$api_key_pepper" ]] || {
  echo "agent_key_pepper_status=reused"
  exit 1
}
replace_or_append BRAIN_AGENT_KEY_EXCHANGE_ENABLED true "$VM_ENV_FILE"
replace_or_append BRAIN_AGENT_KEY_ENVIRONMENT "$AGENT_KEY_ENVIRONMENT" "$VM_ENV_FILE"
replace_or_append BRAIN_API_RESOURCE_URL https://api.brain.fi/ "$VM_ENV_FILE"
replace_or_append BRAIN_AUTH_TOKEN_URL http://auth:3000/token "$VM_ENV_FILE"

bash scripts/ops/prepare-minio-api-env.sh \
  --env "$VM_ENV_FILE" --credentials .env.minio-api --output .env.api.prod
bash scripts/check-required-compose-secrets.sh --compose docker-compose.prod.yml --env "$VM_ENV_FILE"

"${compose[@]}" up -d --no-deps --force-recreate auth
wait_for_commit http://127.0.0.1:3003/healthz auth
"${compose[@]}" up -d --no-deps --force-recreate api
wait_for_commit http://127.0.0.1:3000/health api
echo "exchange_infrastructure=enabled"

if [[ -f "$credential_file" ]]; then
  credential_tenant="$(read_value BRAIN_AGENT_TENANT_ID "$credential_file" || true)"
  credential_agent="$(read_value BRAIN_AGENT_ID "$credential_file" || true)"
  credential_id="$(read_value BRAIN_AGENT_API_KEY_ID "$credential_file" || true)"
  agent_key="$(read_value BRAIN_AGENT_API_KEY "$credential_file" || true)"
  [[ "$credential_tenant" == "$tenant_id" && "$credential_agent" == "$agent_id" ]] || {
    echo "stored_credential_binding_status=mismatch"
    exit 1
  }
  echo "agent_key_issuance_status=preserved"
else
  platform_secret="$(read_value BRAIN_PLATFORM_SERVICE_SECRET || true)"
  [[ -n "$platform_secret" ]] || { echo "platform_service_secret_status=missing"; exit 1; }
  platform_header_file="$(mktemp /tmp/agent-canary-platform-header.XXXXXX)"
  chmod 600 "$platform_header_file"
  printf 'X-Platform-Service-Auth: %s\n' "$platform_secret" > "$platform_header_file"
  unset platform_secret
  payload="$(printf '{"agent_id":"%s","profile":"document_extractor_v1","name":"Phase 3 document extractor canary","environment":"%s"}' "$agent_id" "$AGENT_KEY_ENVIRONMENT")"
  response="$(curl -fsS --connect-timeout 10 --max-time 60 \
    -X POST "http://127.0.0.1:3000/v1/tenants/${tenant_id}/agent-keys" \
    -H "Content-Type: application/json" \
    -H "@${platform_header_file}" \
    -H "Idempotency-Key: phase3-document-extractor-v1-${AGENT_KEY_ENVIRONMENT}-${agent_id}" \
    --data-binary "$payload")"
  tmp_credential="$(mktemp "${credential_file}.tmp.XXXXXX")"
  chmod 600 "$tmp_credential"
  printf '%s' "$response" | "${compose[@]}" exec -T api node -e '
    let body = "";
    process.stdin.on("data", chunk => { body += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(body);
      if (!/^agkey_/.test(value.id ?? "") || !/^tnt_/.test(value.tenant_id ?? "") ||
          !/^agent_/.test(value.agent_id ?? "") || value.profile !== "document_extractor_v1" ||
          !/^brain_ak_(test|live)_/.test(value.api_key ?? "") ||
          JSON.stringify(value.scopes) !== JSON.stringify(["raw:write"])) process.exit(1);
      process.stdout.write([
        `BRAIN_AGENT_API_KEY=${value.api_key}`,
        `BRAIN_AGENT_API_KEY_ID=${value.id}`,
        `BRAIN_AGENT_TENANT_ID=${value.tenant_id}`,
        `BRAIN_AGENT_ID=${value.agent_id}`,
        "",
      ].join("\n"));
    });
  ' > "$tmp_credential"
  mv "$tmp_credential" "$credential_file"
  chmod 600 "$credential_file"
  credential_id="$(read_value BRAIN_AGENT_API_KEY_ID "$credential_file")"
  agent_key="$(read_value BRAIN_AGENT_API_KEY "$credential_file")"
  echo "agent_key_issuance_status=issued"
fi
[[ "$credential_id" =~ ^agkey_ ]] || { echo "credential_id_status=invalid"; exit 1; }
[[ "$agent_key" == "brain_ak_${AGENT_KEY_ENVIRONMENT}_"* ]] || {
  echo "agent_key_environment_status=mismatch"
  exit 1
}
echo "credential_id=$credential_id"
echo "credential_profile=document_extractor_v1"
echo "credential_scopes=raw:write"

rollback_needed=true
replace_or_append BRAIN_AGENTS_AUTH_MODE agent_api_key "$VM_ENV_FILE"
bash scripts/ops/prepare-agents-auth-env.sh \
  --env "$VM_ENV_FILE" --credentials "$credential_file" --output "$agents_auth_file"
bash scripts/check-required-compose-secrets.sh --compose docker-compose.prod.yml --env "$VM_ENV_FILE"
"${compose[@]}" --profile agents up -d --no-deps --force-recreate agents
status=""
for _ in $(seq 1 24); do
  status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' brain-prod-agents 2>/dev/null || true)"
  [[ "$status" == "healthy" ]] && break
  sleep 5
done
[[ "$status" == "healthy" ]] || {
  echo "agents_container_health=$status"
  "${compose[@]}" --profile agents logs --tail=100 agents >&2 || true
  exit 1
}
echo "agents_container_health=healthy"

"${compose[@]}" --profile agents exec -T agents /bin/sh -c '
  test -n "$BRAIN_AGENT_API_KEY"
  test -n "$BRAIN_AUTH_TOKEN_URL"
  test -n "$BRAIN_API_RESOURCE_URL"
  test -z "${BRAIN_API_TOKEN+x}"
'
runtime_key="$("${compose[@]}" --profile agents exec -T agents printenv BRAIN_AGENT_API_KEY | tr -d '\r')"
runtime_key_hash="$(printf '%s' "$runtime_key" | sha256sum | cut -d' ' -f1)"
stored_key_hash="$(printf '%s' "$agent_key" | sha256sum | cut -d' ' -f1)"
[[ "$runtime_key_hash" == "$stored_key_hash" ]] || { echo "runtime_agent_key_match=false"; exit 1; }
echo "runtime_agent_key_match=true"
echo "runtime_legacy_jwt=absent"

"${compose[@]}" --profile agents exec -T \
  -e EXPECTED_TENANT_ID="$tenant_id" \
  -e EXPECTED_AGENT_ID="$agent_id" \
  -e EXPECTED_CREDENTIAL_ID="$credential_id" \
  agents python - <<'PY'
import asyncio
import json
import os
import time

from brain_agents.client import AgentTokenManager
from brain_agents.jwt_util import jwt_claims


async def main() -> None:
    manager = AgentTokenManager(
        agent_api_key=os.environ["BRAIN_AGENT_API_KEY"],
        token_url=os.environ["BRAIN_AUTH_TOKEN_URL"],
        resource=os.environ["BRAIN_API_RESOURCE_URL"],
        scope="raw:write",
    )
    token = await manager.get_access_token()
    claims = jwt_claims(token)
    if claims is None:
        raise RuntimeError("exchanged token is not a JWT")
    ttl = int(claims["exp"]) - int(claims["iat"])
    expected = {
        "sub": os.environ["EXPECTED_AGENT_ID"],
        "tenant_id": os.environ["EXPECTED_TENANT_ID"],
        "aud": os.environ["BRAIN_API_RESOURCE_URL"],
        "principal_type": "agent",
        "credential_id": os.environ["EXPECTED_CREDENTIAL_ID"],
        "scopes": ["raw:write"],
    }
    for name, value in expected.items():
        if claims.get(name) != value:
            raise RuntimeError(f"claim mismatch: {name}")
    if ttl <= 0 or ttl > 300 or int(claims["exp"]) <= int(time.time()):
        raise RuntimeError("invalid exchanged token lifetime")
    print(json.dumps({**expected, "ttl_seconds": ttl}, separators=(",", ":")))


asyncio.run(main())
PY
echo "runtime_exchange_claims=confirmed"

upload_response="$(curl -fsS --connect-timeout 10 --max-time 90 \
  -X POST http://127.0.0.1:3000/v1/raw/ingest \
  -H "@${legacy_header_file}" \
  -F source_type=pdf_upload \
  -F 'source_ref={"filename":"phase3_canary.pdf","fixture_origin":"phase3_document_extractor_canary"}' \
  -F mime_type=application/pdf \
  -F "file=@${FIXTURE_PATH};type=application/pdf")"
raw_id="$(printf '%s' "$upload_response" | "${compose[@]}" exec -T api node -e '
  let body = "";
  process.stdin.on("data", chunk => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (!/^raw_/.test(value.raw_id ?? "")) process.exit(1);
    process.stdout.write(value.raw_id);
  });
')"
echo "canary_raw_id=$raw_id"

denied_status="$("${compose[@]}" --profile agents exec -T -e RAW_ID="$raw_id" agents python - <<'PY'
import asyncio
import os

import httpx

from brain_agents.client import AgentTokenManager


async def main() -> None:
    manager = AgentTokenManager(
        agent_api_key=os.environ["BRAIN_AGENT_API_KEY"],
        token_url=os.environ["BRAIN_AUTH_TOKEN_URL"],
        resource=os.environ["BRAIN_API_RESOURCE_URL"],
        scope="raw:write",
    )
    token = await manager.get_access_token()
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{os.environ['BRAIN_API_BASE_URL'].rstrip('/')}/v1/raw/{os.environ['RAW_ID']}",
            headers={"Authorization": f"Bearer {token}"},
        )
    print(response.status_code)


asyncio.run(main())
PY
)"
[[ "$denied_status" == "403" ]] || { echo "raw_read_denial_status=$denied_status"; exit 1; }
echo "raw_read_denial_status=403"

trigger_status="$(curl -sS --connect-timeout 10 --max-time 90 -o /tmp/agent-canary-trigger-body \
  -w '%{http_code}' -X POST "http://127.0.0.1:3000/v1/raw/${raw_id}/extract" \
  -H "@${legacy_header_file}")"
rm -f /tmp/agent-canary-trigger-body
[[ "$trigger_status" == "200" || "$trigger_status" == "202" ]] || {
  echo "extraction_trigger_status=$trigger_status"
  exit 1
}
echo "extraction_trigger_status=$trigger_status"

parsed_id=""
projection_status=""
for _ in $(seq 1 72); do
  state="$(docker exec -i brain-prod-postgres psql -X -At -U brain -d brain \
    -v tenant_id="$tenant_id" -v raw_id="$raw_id" <<'SQL'
SELECT COALESCE(j.status, '') || E'\t' || COALESCE(j.parsed_id, '') || E'\t' ||
       COALESCE(a.projection_status, '')
  FROM extraction_jobs j
  JOIN raw_artifacts a ON a.tenant_id = j.tenant_id AND a.id = j.raw_id
 WHERE j.tenant_id = :'tenant_id' AND j.raw_id = :'raw_id'
 ORDER BY j.created_at DESC
 LIMIT 1;
SQL
)"
  job_status="${state%%$'\t'*}"
  rest="${state#*$'\t'}"
  parsed_id="${rest%%$'\t'*}"
  projection_status="${rest#*$'\t'}"
  if [[ "$job_status" == "succeeded" && "$parsed_id" == prs_* && "$projection_status" == "projected" ]]; then
    break
  fi
  [[ "$job_status" != "failed" ]] || { echo "extraction_job_status=failed"; exit 1; }
  [[ "$projection_status" != "projection_failed" ]] || {
    echo "projection_status=projection_failed"
    exit 1
  }
  sleep 10
done
[[ "$job_status" == "succeeded" && "$parsed_id" == prs_* && "$projection_status" == "projected" ]] || {
  echo "extraction_lifecycle_status=timed_out"
  exit 1
}
echo "extraction_job_status=succeeded"
echo "canary_parsed_id=$parsed_id"
echo "projection_status=projected"

evidence="$(docker exec -i brain-prod-postgres psql -X -At -U brain -d brain \
  -v tenant_id="$tenant_id" -v agent_id="$agent_id" \
  -v credential_id="$credential_id" -v parsed_id="$parsed_id" <<'SQL'
SELECT
  (EXISTS (
    SELECT 1 FROM agent_api_keys
     WHERE tenant_id = :'tenant_id'
       AND id = :'credential_id'
       AND agent_id = :'agent_id'
       AND profile = 'document_extractor_v1'
       AND scopes = ARRAY['raw:write']::text[]
       AND revoked_at IS NULL
       AND expires_at > now()
       AND last_used_at IS NOT NULL
  ))::int,
  (EXISTS (
    SELECT 1 FROM audit_events
     WHERE tenant_id = :'tenant_id'
       AND action = 'oauth.agent_api_key.exchanged'
       AND actor = :'agent_id'
       AND inputs ->> 'credential_id' = :'credential_id'
  ))::int,
  (EXISTS (
    SELECT 1 FROM raw_parsed
     WHERE tenant_id = :'tenant_id' AND id = :'parsed_id'
  ))::int;
SQL
)"
[[ "$evidence" == "1|1|1" ]] || { echo "canary_evidence_status=incomplete:$evidence"; exit 1; }
echo "credential_database_state=active_and_used"
echo "exchange_audit_evidence=confirmed"
echo "parsed_lifecycle_evidence=confirmed"
echo "legacy_jwt_revoked=false"
echo "agent_token_route_retired=false"
echo "canary_status=confirmed"
rollback_needed=false
