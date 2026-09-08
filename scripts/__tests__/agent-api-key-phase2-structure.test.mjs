import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const pythonClient = read("services/agents/brain_agents/client.py");
const pythonConfig = read("services/agents/brain_agents/config.py");
const pythonServer = read("services/agents/brain_agents/server.py");
const sdkClient = read("clients/sdk/src/client.ts");
const sdkExchange = read("clients/sdk/src/agent-api-key.ts");
const compose = read("docker-compose.prod.yml");
const developmentCompose = read("docker-compose.yml") + read("docker-compose.dev.yml");
const terraform = read("infra/main.tf");

function composeService(name) {
  const marker = `\n  ${name}:\n`;
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} service`);
  const remaining = compose.slice(start + marker.length);
  const next = /\n  [a-z0-9_-]+:\n/.exec(remaining);
  const end = next === null ? compose.length : start + marker.length + next.index;
  return compose.slice(start, end);
}

test("Python agent key mode exchanges at boot and covers every request method", () => {
  assert.match(pythonConfig, /brain_agent_api_key:\s*str/);
  assert.match(pythonConfig, /brain_auth_token_url:\s*str/);
  assert.match(pythonServer, /await brain_client\.start\(\)/);
  assert.match(pythonClient, /class AgentTokenManager/);
  assert.match(pythonClient, /refresh_after_unauthorized/);
  assert.match(pythonClient, /async def _request/);
  assert.match(pythonClient, /await self\._request\(\s*"GET"/);
  assert.match(pythonClient, /return await self\._request\("POST"/);
  assert.doesNotMatch(pythonClient + pythonConfig, /platform_service_secret/i);
});

test("SDK agentApiKey mode is exchange-only and commercial apiKey stays direct", () => {
  assert.match(sdkClient, /agentApiKey\?: string/);
  assert.match(sdkClient, /createAgentAuthenticatedFetch/);
  assert.match(sdkClient, /options\.apiKey \? \{ Authorization: `Bearer \$\{options\.apiKey\}` \}/);
  assert.doesNotMatch(sdkClient, /Authorization: `Bearer \$\{options\.agentApiKey\}`/);
  assert.match(sdkExchange, /subject_token: this\.options\.agentApiKey/);
  assert.match(sdkExchange, /response\.status === 401/);
  assert.match(sdkExchange, /exchangeInFlight/);
  assert.match(sdkExchange, /EARLY_REFRESH_SECONDS = 60/);
});

test("Phase 2 does not cut over either live agents deployment", () => {
  const agents = composeService("agents");
  assert.match(agents, /BRAIN_API_TOKEN:/);
  assert.doesNotMatch(agents, /BRAIN_AGENT_API_KEY:/);
  assert.doesNotMatch(agents, /BRAIN_AUTH_TOKEN_URL:/);

  const agentsContainer = terraform.slice(
    terraform.indexOf('name   = "agents"'),
    terraform.indexOf("\n    }\n  }\n\n  ingress", terraform.indexOf('name   = "agents"')),
  );
  assert.match(agentsContainer, /name\s*=\s*"BRAIN_API_TOKEN"/);
  assert.doesNotMatch(agentsContainer, /BRAIN_AGENT_API_KEY|BRAIN_AUTH_TOKEN_URL/);
});

test("local Compose can exercise either agent credential mode", () => {
  assert.match(developmentCompose, /BRAIN_API_TOKEN:/);
  assert.match(developmentCompose, /BRAIN_AGENT_API_KEY:/);
  assert.match(developmentCompose, /BRAIN_AUTH_TOKEN_URL:/);
  assert.match(developmentCompose, /BRAIN_API_RESOURCE_URL:/);
});
