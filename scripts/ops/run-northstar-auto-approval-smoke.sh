#!/usr/bin/env bash
set -euo pipefail

: "${VM_ENV_FILE:?VM_ENV_FILE is required}"
: "${API_BASE:?API_BASE is required}"

cd ~/brain-core
set -a
. "./${VM_ENV_FILE}"
set +a
: "${BRAIN_PLATFORM_SERVICE_SECRET:?BRAIN_PLATFORM_SERVICE_SECRET is required}"

create_payload="$(docker exec brain-prod-api node -e '
  const { randomUUID } = require("node:crypto");
  const suffix = randomUUID().replace(/-/g, "");
  process.stdout.write(JSON.stringify({
    company_name: "Northstar payment policy smoke",
    founder: {
      email: "northstar-payment-smoke+" + suffix + "@brain.invalid",
      display_name: "Northstar Payment Smoke",
    },
    founder_external_ref: "northstar-payment-smoke:" + suffix,
    demo_seed: false,
  }));
')"
create_response="$(printf '%s' "$create_payload" | curl -fsS --connect-timeout 10 --max-time 90 \
  -X POST "$API_BASE/v1/tenants" \
  -H 'Content-Type: application/json' \
  -H "X-Platform-Service-Auth: ${BRAIN_PLATFORM_SERVICE_SECRET}" \
  --data-binary @-)"
smoke_tenant_id="$(printf '%s' "$create_response" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (!/^tnt_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.tenant_id ?? "")) process.exit(1);
    process.stdout.write(value.tenant_id);
  });
')"
actor_id="$(printf '%s' "$create_response" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.member?.id ?? "")) process.exit(1);
    process.stdout.write(value.member.id);
  });
')"
printf 'northstar_auto_approval_smoke_tenant_id=%s\n' "$smoke_tenant_id"

docker exec -e BRAIN_TENANT_ID="$smoke_tenant_id" -e BRAIN_ACTOR="$actor_id" \
  brain-prod-api node tools/seed-northstar-demo/dist/cli.js

ids="$(docker exec brain-prod-postgres psql -X -qAt -U brain -d brain -v ON_ERROR_STOP=1 -c "
  SELECT json_build_object(
    'source_account_id', (
      SELECT id FROM ledger_accounts
       WHERE owner_id = '${smoke_tenant_id}'
         AND external_account_id = 'northstar:operating:001'
       LIMIT 1
    ),
    'counterparty_id', (
      SELECT id FROM ledger_counterparties
       WHERE owner_id = '${smoke_tenant_id}' AND name = 'Cascade Compute'
       LIMIT 1
    ),
    'obligation_id', (
      SELECT o.id FROM ledger_obligations o
       JOIN ledger_counterparties c ON c.id = o.counterparty_id AND c.owner_id = o.owner_id
      WHERE o.owner_id = '${smoke_tenant_id}' AND c.name = 'Cascade Compute'
       LIMIT 1
    )
  )::text;")"
printf '%s' "$ids" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (Object.values(value).some((id) => typeof id !== "string" || id.length === 0)) process.exit(1);
  });
'

agent_id="$(docker exec -w /app/services/api brain-prod-api node --input-type=module -e '
  import { newAgentId } from "@brain/shared";
  process.stdout.write(newAgentId());
')"
[[ "$agent_id" =~ ^agent_[0-9A-HJKMNP-TV-Z]{26}$ ]]
docker exec brain-prod-postgres psql -X -qAt -U brain -d brain -v ON_ERROR_STOP=1 -c "
  INSERT INTO agents (
    id, tenant_id, kind, role, display_name, scope_hash, state,
    registered_at, created_at, contribution_count, quarantine_threshold
  ) VALUES (
    '${agent_id}', '${smoke_tenant_id}', 'internal', 'payment',
    'Northstar payment policy smoke', decode(repeat('00', 32), 'hex'), 'active',
    now(), now(), 0, 100
  );"

agent_token="$(docker exec -w /app/services/api \
  -e SMOKE_TENANT_ID="$smoke_tenant_id" \
  -e SMOKE_AGENT_ID="$agent_id" \
  brain-prod-api node --input-type=module -e '
    import { JwtSigner, newTokenId } from "@brain/shared";
    const key = JSON.parse(process.env.AUTH_SIGN_KEY);
    const signer = new JwtSigner({
      issuer: process.env.AUTH_ISSUER,
      audience: process.env.AUTH_AUDIENCE,
      key,
      algorithm: key.alg ?? "HS256",
    });
    process.stdout.write(await signer.sign({
      id: process.env.SMOKE_AGENT_ID,
      type: "agent",
      tenantId: process.env.SMOKE_TENANT_ID,
      tokenId: newTokenId(),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      scopes: ["ledger:read", "wiki:read", "payment_intent:propose", "execution:propose"],
    }));
  ')"

request_body="$(printf '%s' "$ids" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const ids = JSON.parse(body);
    process.stdout.write(JSON.stringify({
      event: "invoice.approved",
      context: {
        source_account_id: ids.source_account_id,
        account_id: ids.source_account_id,
        destination_counterparty_id: ids.counterparty_id,
        counterparty_id: ids.counterparty_id,
        obligation_id: ids.obligation_id,
        payment_destination_id: "cpi_northstar_payment_smoke",
        payment_destination_confidence: 1,
        amount: "5000.00",
        currency: "USD",
      },
    }));
  });
')"
printf 'northstar_auto_approval_request=%s\n' "$request_body"
response="$(printf '%s' "$request_body" | curl -fsS --connect-timeout 10 --max-time 60 \
  -X POST "$API_BASE/v1/agents/run" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${agent_token}" \
  --data-binary @-)"
printf 'northstar_auto_approval_response=%s\n' "$response"
payment_intent_id="$(printf '%s' "$response" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (value.selected_agent_id !== "payment" || value.status !== "proposal_created") process.exit(1);
    if (value.proposed?.status !== "approved") process.exit(1);
    if (!/^pi_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.proposed?.id ?? "")) process.exit(1);
    process.stdout.write(value.proposed.id);
  });
')"

result="$(docker exec brain-prod-postgres psql -X -qAt -U brain -d brain -v ON_ERROR_STOP=1 -c "
  SELECT json_build_object(
    'payment_intent_id', pi.id,
    'payment_intent_status', pi.status,
    'risk_level', pi.risk_level,
    'policy_outcome', pd.outcome,
    'matched_rule_id', pd.matched_rule_id,
    'policy_trace', pd.trace,
    'auto_approved_audit_count', (
      SELECT count(*) FROM audit_events ae
       WHERE ae.tenant_id = pi.owner_id
         AND ae.action = 'payment_intent.auto_approved'
         AND ae.inputs->>'payment_intent_id' = pi.id
    )
  )::text
  FROM ledger_payment_intents pi
  JOIN policy_decisions pd ON pd.id = pi.policy_decision_id AND pd.tenant_id = pi.owner_id
  WHERE pi.owner_id = '${smoke_tenant_id}' AND pi.id = '${payment_intent_id}';")"
printf 'northstar_auto_approval_result=%s\n' "$result"
printf '%s' "$result" | docker exec -i brain-prod-api node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(body);
    if (value.payment_intent_status !== "approved") process.exit(1);
    if (value.risk_level !== "medium") process.exit(1);
    if (value.policy_outcome !== "allow") process.exit(1);
    if (value.matched_rule_id !== "northstar-ap-auto-approved") process.exit(1);
    if (value.auto_approved_audit_count !== 1) process.exit(1);
    const checks = value.policy_trace?.[0]?.checks;
    if (!Array.isArray(checks) || !checks.some((check) => check.key === "agent.risk_level.lte" && check.passed === true)) process.exit(1);
  });
'
printf 'northstar_auto_approval_smoke_completed\n'

