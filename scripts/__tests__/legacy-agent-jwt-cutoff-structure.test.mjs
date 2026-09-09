import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CUTOFF = "2026-09-16T23:59:59Z";
const read = (path) => readFileSync(path, "utf8");

test("production config requires the fixed legacy agent JWT cutoff", () => {
  const config = read("shared/src/config.ts");
  assert.match(config, /LEGACY_AGENT_JWT_NOT_AFTER/);
  assert.match(config, new RegExp(CUTOFF.replaceAll("-", "\\-")));
  assert.match(config, /NODE_ENV === "production"[\s\S]*LEGACY_AGENT_JWT_NOT_AFTER/);
});

test("the shared verifier rejects unbound agent JWTs at the cutoff", () => {
  const jwt = read("shared/src/auth/jwt.ts");
  assert.match(jwt, /principal\.type === "agent"/);
  assert.match(jwt, /principal\.credentialId === undefined/);
  assert.match(jwt, />= opts\.legacyAgentJwtNotAfter\.getTime\(\)/);
  assert.match(jwt, /legacy_agent_jwt_cutoff_reached/);
});

test("every runtime Brain JWT verifier receives the cutoff", () => {
  for (const path of ["services/api/src/main.ts", "services/surface-gateway/src/main.ts"]) {
    const source = read(path);
    const constructor = source.slice(source.indexOf("new JwtVerifier"));
    assert.match(constructor, /legacyAgentJwtNotAfter:/, path);
  }

  for (const path of [
    "services/audit/src/server.ts",
    "services/execution/src/server.ts",
    "services/ledger/src/server.ts",
    "services/policy/src/server.ts",
    "services/raw/src/server.ts",
    "services/wiki/src/server.ts",
  ]) {
    assert.match(read(path), /authPlugin, \{ verifier: opts\.jwtVerifier \}/, path);
  }
});

test("production deployment surfaces carry the fixed cutoff", () => {
  const compose = read("docker-compose.prod.yml");
  assert.ok(compose.match(new RegExp(`LEGACY_AGENT_JWT_NOT_AFTER: "${CUTOFF}"`, "g"))?.length >= 3);
  assert.match(read("infra/main.tf"), new RegExp(`LEGACY_AGENT_JWT_NOT_AFTER\\s+= "${CUTOFF}"`));
  assert.match(read(".env.prod.example"), new RegExp(`LEGACY_AGENT_JWT_NOT_AFTER=${CUTOFF}`));
});

test("agent-token cutoff runs before tenant or token state access", () => {
  const routes = read("services/api/src/production-tenancy/routes.ts");
  const route = routes.slice(routes.indexOf('"/tenants/:tenantId/agent-token"'));
  const guardAt = route.indexOf("assertLegacyAgentJwtMintingEnabled");
  const tenantScopeAt = route.indexOf("withTenantScope");
  assert.ok(guardAt >= 0);
  assert.ok(tenantScopeAt > guardAt);
});
