import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(".github/workflows/main.yml", "utf8");
const terraform = readFileSync("infra/main.tf", "utf8");
const variables = readFileSync("infra/variables.tf", "utf8");

test("main workflow builds the agents image from the agents context", () => {
  assert.match(
    workflow,
    /service:\s*agents[\s\S]*dockerfile:\s*services\/agents\/Dockerfile[\s\S]*context:\s*services\/agents/,
  );
  assert.match(workflow, /context:\s*\$\{\{\s*matrix\.context\s*\|\|\s*'\.'\s*\}\}/);
});

test("main workflow runs Python agents checks", () => {
  assert.match(workflow, /uv run ruff check \./);
  assert.match(workflow, /uv run black --check \./);
  assert.match(workflow, /uv run mypy --strict brain_agents/);
  assert.match(workflow, /uv run pytest/);
});

test("staging and production deploy the api and agents apps together", () => {
  const deployLoops = workflow.match(/for svc in api agents; do/g) ?? [];
  assert.equal(deployLoops.length, 2);
});

test("terraform defaults include agents and keeps it internally exposed", () => {
  assert.match(variables, /default\s*=\s*\[[^\]]*"agents"[^\]]*\]/);
  assert.match(terraform, /external_enabled\s*=\s*each\.key\s*==\s*"api"/);
  assert.match(terraform, /service_ports\s*=\s*merge\(/);
  assert.match(terraform, /agents\s*=\s*8001/);
  assert.match(terraform, /target_port\s*=\s*local\.service_ports\[each\.key\]/);
});

test("terraform wires agents secrets and api extraction callback configuration", () => {
  for (const name of [
    "openai_api_key_secret_name",
    "brain_agents_inbound_secret_name",
    "brain_api_token_secret_name",
  ]) {
    assert.match(variables, new RegExp(`variable "${name}"`));
  }

  for (const name of [
    "OPENAI_API_KEY",
    "BRAIN_AGENTS_INBOUND_SECRET",
    "BRAIN_API_TOKEN",
    "BRAIN_API_BASE_URL",
    "DOCUMENT_EXTRACT_AGENT_URL",
  ]) {
    assert.match(terraform, new RegExp(`name\\s*=\\s*"${name}"`));
  }

  assert.match(
    terraform,
    /key_vault_secret_id\s*=\s*data\.azurerm_key_vault_secret\.openai_api_key\[0\]\.id/,
  );
  assert.match(
    terraform,
    /key_vault_secret_id\s*=\s*data\.azurerm_key_vault_secret\.brain_agents_inbound_secret\[0\]\.id/,
  );
  assert.match(
    terraform,
    /key_vault_secret_id\s*=\s*data\.azurerm_key_vault_secret\.brain_api_token\[0\]\.id/,
  );
});
