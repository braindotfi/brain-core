import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(".github/workflows/main.yml", "utf8");
const composeProd = readFileSync("docker-compose.prod.yml", "utf8");
const envProdExample = readFileSync(".env.prod.example", "utf8");

test("main workflow runs Python agents checks before VM deploy", () => {
  assert.match(workflow, /python_agents:/);
  assert.match(workflow, /uv run ruff check \./);
  assert.match(workflow, /uv run black --check \./);
  assert.match(workflow, /uv run mypy --strict brain_agents/);
  assert.match(workflow, /uv run pytest/);
  assert.match(
    workflow,
    /deploy_vm:[\s\S]*needs:\s*\[unit_and_integration, golden_path_smoke, python_agents\]/,
  );
});

test("main workflow ships one root production image to the VM with migration and health gates", () => {
  assert.match(
    workflow,
    /docker build --build-arg GIT_SHA=\$\{\{ github\.sha \}\} -t brain-core:prod -f Dockerfile \./,
  );
  assert.match(workflow, /docker save brain-core:prod \| gzip \| ssh/);
  assert.match(workflow, /tools\/migrate\/dist\/cli\.js up/);
  assert.match(workflow, /up -d --no-deps --no-build api worker/);
  assert.match(workflow, /https:\/\/api\.brain\.fi\/health/);
  assert.match(workflow, /last_commit.*expected/s);
});

test("production compose defines the optional Python agents service", () => {
  assert.match(composeProd, /agents:\n\s+profiles:\s*\["agents"\]/);
  assert.match(
    composeProd,
    /agents:[\s\S]*build:\n\s+context:\s+services\/agents\n\s+dockerfile:\s+Dockerfile/,
  );
  assert.match(composeProd, /container_name:\s+brain-prod-agents/);
  assert.match(composeProd, /BRAIN_API_BASE_URL:\s+http:\/\/api:3000/);
  assert.match(composeProd, /depends_on:[\s\S]*api:[\s\S]*condition:\s+service_healthy/);
});

test("production env example documents API to agents extraction wiring", () => {
  for (const name of [
    "OPENAI_API_KEY",
    "DOCUMENT_EXTRACT_AGENT_URL",
    "BRAIN_AGENTS_INBOUND_SECRET",
    "BRAIN_API_TOKEN",
  ]) {
    assert.match(envProdExample, new RegExp(`^${name}=`, "m"));
  }
});
