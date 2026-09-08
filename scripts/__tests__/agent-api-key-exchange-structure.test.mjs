import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("agent exchange keys remain structurally separate from commercial API keys", () => {
  const migration = read("services/api/migrations/0036_agent_api_keys.sql");
  const middleware = read("shared/src/auth/middleware.ts");
  const routes = read("services/api/src/production-tenancy/agent-key-routes.ts");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS agent_api_keys/);
  assert.match(migration, /profile = 'document_extractor_v1'.*ARRAY\['raw:write'\]/s);
  assert.match(migration, /profile = 'bff_service_v1'.*'payment_intent:propose'.*'audit:read'/s);
  assert.doesNotMatch(migration, /ALTER TABLE api_keys/);
  assert.match(routes, /generateAgentApiKey/);
  assert.doesNotMatch(routes, /generateApiKeySecret/);
  assert.match(middleware, /token\.startsWith\("brain_ak_"\)/);
  assert.match(middleware, /must be exchanged for an access token/);
});

test("the exchange role has only read plus last-used update on agent keys", () => {
  const roles = read("infra/db-roles.sql");
  assert.match(roles, /GRANT SELECT ON agent_api_keys TO brain_auth;/);
  assert.match(roles, /GRANT UPDATE \(last_used_at\) ON agent_api_keys TO brain_auth;/);
  assert.doesNotMatch(roles, /GRANT (?:INSERT|DELETE|TRUNCATE).*agent_api_keys TO brain_auth/);
  assert.match(roles, /GRANT SELECT \(id, tenant_id\) ON agent_api_keys TO brain_resolver;/);
});

test("deployment wiring is default-off and boot-fenced", () => {
  const config = read("shared/src/config.ts");
  const compose = read("docker-compose.prod.yml");
  const terraform = read("infra/main.tf");
  const workerRenderer = read("scripts/ops/prepare-minio-worker-env.sh");
  const preflight = read("scripts/check-required-compose-secrets.sh");

  assert.match(config, /BRAIN_AGENT_KEY_EXCHANGE_ENABLED/);
  assert.match(config, /\.default\(false\)/);
  assert.match(
    compose,
    /BRAIN_AGENT_KEY_EXCHANGE_ENABLED: \$\{BRAIN_AGENT_KEY_EXCHANGE_ENABLED:-false\}/,
  );
  assert.match(preflight, /add_requirement BRAIN_AGENT_API_KEY_PEPPER/);
  assert.match(preflight, /add_requirement BRAIN_AGENT_KEY_ENVIRONMENT/);
  assert.match(preflight, /add_requirement BRAIN_PLATFORM_SERVICE_SECRET/);
  assert.match(serviceBlock(compose, "worker"), /BRAIN_AGENT_KEY_EXCHANGE_ENABLED: "false"/);
  assert.match(workerRenderer, /BRAIN_AGENT_API_KEY_PEPPER/);
  assert.match(terraform, /worker_kv_secret_refs[\s\S]*name != "brain-agent-api-key-pepper"/);
  assert.match(terraform, /for_each = local\.worker_kv_secret_refs/);
});

test("legacy JWT and agent-token paths remain present during Phase 1", () => {
  const tenancyRoutes = read("services/api/src/production-tenancy/routes.ts");
  const authMiddleware = read("shared/src/auth/middleware.ts");
  assert.match(tenancyRoutes, /"\/tenants\/:tenantId\/agent-token"/);
  assert.match(authMiddleware, /await verifier\.verify\(token\)/);
});

function serviceBlock(compose, name) {
  const match = compose.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^volumes:)`, "m"),
  );
  assert.ok(match, `missing ${name} service`);
  return match[0];
}
