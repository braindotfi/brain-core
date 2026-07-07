import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(".github/workflows/main.yml", "utf8");
const composeProd = readFileSync("docker-compose.prod.yml", "utf8");
const envProdExample = readFileSync(".env.prod.example", "utf8");

function workflowJob(name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const next = workflow.slice(start + 1).match(/\n  [a-zA-Z0-9_]+:\n/);
  const end = next ? start + 1 + next.index : workflow.length;
  return workflow.slice(start, end);
}

test("main workflow runs Python agents checks before VM image build", () => {
  const buildImageJob = workflowJob("build_image");

  assert.match(workflow, /python_agents:/);
  assert.match(workflow, /uv run ruff check \./);
  assert.match(workflow, /uv run black --check \./);
  assert.match(workflow, /uv run mypy --strict brain_agents/);
  assert.match(workflow, /uv run pytest/);
  assert.match(
    buildImageJob,
    /needs:\s*\[unit_and_integration, golden_path_smoke, python_agents\]/,
  );
});

test("main workflow builds one root image and deploys staging before manual production promote", () => {
  const buildImageJob = workflowJob("build_image");
  const deployStagingJob = workflowJob("deploy_staging");
  const promoteProductionJob = workflowJob("promote_production");

  assert.match(
    buildImageJob,
    /docker build --build-arg GIT_SHA=\$\{\{ github\.sha \}\} -t brain-core:prod-\$\{\{ github\.sha \}\} -f Dockerfile \./,
  );
  assert.match(buildImageJob, /actions\/upload-artifact@v4/);
  assert.match(deployStagingJob, /needs: build_image/);
  assert.match(deployStagingJob, /VM_HOST: \$\{\{ secrets\.VM_HOST_STAGING \}\}/);
  assert.match(deployStagingJob, /VM_ENV_FILE: \.env\.staging/);
  assert.match(promoteProductionJob, /needs: deploy_staging/);
  assert.match(promoteProductionJob, /environment:\s*production/);
  assert.match(promoteProductionJob, /VM_HOST: \$\{\{ secrets\.VM_HOST \}\}/);
  assert.match(promoteProductionJob, /VM_ENV_FILE: \.env\.prod/);
  assert.match(deployStagingJob, /gunzip \| docker load/);
  assert.match(promoteProductionJob, /gunzip \| docker load/);
  assert.match(workflow, /tools\/migrate\/dist\/cli\.js up/);
  assert.match(workflow, /https:\/\/api\.brain\.fi\/health/);
  assert.match(workflow, /last_commit.*expected/s);
});

test("staging and production deploy recreates include the agents service", () => {
  const deployStagingJob = workflowJob("deploy_staging");
  const promoteProductionJob = workflowJob("promote_production");
  const serviceTargets = "api worker agents";
  assert.match(
    deployStagingJob,
    new RegExp(`up -d --no-deps --no-build ${serviceTargets}`),
  );
  assert.match(
    promoteProductionJob,
    new RegExp(`up -d --no-deps --no-build ${serviceTargets}`),
  );
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
