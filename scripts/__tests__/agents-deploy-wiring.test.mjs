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

test("main workflow builds app and agents images before deployment", () => {
  const buildImageJob = workflowJob("build_image");
  const deployStagingJob = workflowJob("deploy_staging");
  const promoteProductionJob = workflowJob("promote_production");

  assert.match(
    buildImageJob,
    /docker build --build-arg GIT_SHA=\$\{\{ github\.sha \}\} -t ghcr\.io\/braindotfi\/brain-core:\$\{\{ github\.sha \}\} -f Dockerfile \./,
  );
  assert.match(
    buildImageJob,
    /docker push ghcr\.io\/braindotfi\/brain-core:\$\{\{ github\.sha \}\}/,
  );
  assert.match(
    buildImageJob,
    /docker build -t ghcr\.io\/braindotfi\/brain-agents:\$\{\{ github\.sha \}\} -f services\/agents\/Dockerfile services\/agents/,
  );
  assert.match(
    buildImageJob,
    /docker push ghcr\.io\/braindotfi\/brain-agents:\$\{\{ github\.sha \}\}/,
  );
  assert.match(deployStagingJob, /needs: build_image/);
  assert.match(deployStagingJob, /VM_HOST: \$\{\{ secrets\.VM_HOST_STAGING \}\}/);
  assert.match(deployStagingJob, /VM_ENV_FILE: \.env\.staging/);
  assert.match(promoteProductionJob, /needs: deploy_staging/);
  assert.match(promoteProductionJob, /environment:\s*production/);
  assert.match(promoteProductionJob, /VM_HOST: \$\{\{ secrets\.VM_HOST \}\}/);
  assert.match(promoteProductionJob, /VM_ENV_FILE: \.env\.prod/);
  assert.match(
    deployStagingJob,
    /docker pull ghcr\.io\/braindotfi\/brain-core:\$\{\{ github\.sha \}\}/,
  );
  assert.match(
    promoteProductionJob,
    /docker pull ghcr\.io\/braindotfi\/brain-core:\$\{\{ github\.sha \}\}/,
  );
  assert.match(
    deployStagingJob,
    /docker pull ghcr\.io\/braindotfi\/brain-agents:\$\{\{ github\.sha \}\}/,
  );
  assert.match(
    promoteProductionJob,
    /docker pull ghcr\.io\/braindotfi\/brain-agents:\$\{\{ github\.sha \}\}/,
  );
  assert.match(
    deployStagingJob,
    /docker tag ghcr\.io\/braindotfi\/brain-core:\$\{\{ github\.sha \}\} brain-core:prod/,
  );
  assert.match(
    promoteProductionJob,
    /docker tag ghcr\.io\/braindotfi\/brain-core:\$\{\{ github\.sha \}\} brain-core:prod/,
  );
  assert.match(
    deployStagingJob,
    /docker tag ghcr\.io\/braindotfi\/brain-agents:\$\{\{ github\.sha \}\} brain-agents:prod/,
  );
  assert.match(
    promoteProductionJob,
    /docker tag ghcr\.io\/braindotfi\/brain-agents:\$\{\{ github\.sha \}\} brain-agents:prod/,
  );
  assert.match(deployStagingJob, /brain-agents:prod-rollback-\$ts/);
  assert.match(promoteProductionJob, /brain-agents:prod-rollback-\$ts/);
  assert.match(workflow, /tools\/migrate\/dist\/cli\.js up/);
  assert.match(workflow, /https:\/\/api\.brain\.fi\/health/);
  assert.match(workflow, /last_commit.*expected/s);
});

test("staging and production deploy recreates include the agents service", () => {
  const deployStagingJob = workflowJob("deploy_staging");
  const promoteProductionJob = workflowJob("promote_production");
  const serviceTargets = "api worker agents";
  assert.match(deployStagingJob, new RegExp(`up -d --no-deps --no-build ${serviceTargets}`));
  assert.match(promoteProductionJob, new RegExp(`up -d --no-deps --no-build ${serviceTargets}`));
});

test("staging and production deploy rerun db role grants after migrations", () => {
  const deployStagingJob = workflowJob("deploy_staging");
  const promoteProductionJob = workflowJob("promote_production");

  for (const [name, job] of [
    ["deploy_staging", deployStagingJob],
    ["promote_production", promoteProductionJob],
  ]) {
    assert.match(
      job,
      /tools\/migrate\/dist\/cli\.js up && \\\s+docker compose [\s\S]*?run --rm --no-deps db-roles && \\\s+\(docker compose [\s\S]*?up -d --no-deps --no-build api worker agents/,
      `${name} must apply migrations, rerun db-roles, then recreate services`,
    );
    assert.match(job, /logs --tail=200 api worker agents/, `${name} must print deploy logs`);
  }
});

test("production compose defines the optional Python agents service", () => {
  assert.match(composeProd, /agents:\n\s+profiles:\s*\["agents"\]/);
  assert.match(
    composeProd,
    /agents:[\s\S]*image:\s+brain-agents:\$\{BRAIN_AGENTS_IMAGE_TAG:-prod\}/,
  );
  assert.doesNotMatch(
    composeProd.match(/  agents:[\s\S]*?(?=\nvolumes:)/)?.[0] ?? "",
    /\n\s+build:/,
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

test("production env example documents self-serve signup email delivery wiring", () => {
  for (const name of [
    "BRAIN_SELF_SERVE_SIGNUP",
    "EMAIL_ENABLED",
    "EMAIL_ENDPOINT",
    "EMAIL_API_KEY",
    "EMAIL_FROM",
  ]) {
    assert.match(envProdExample, new RegExp(`^${name}=`, "m"));
  }
  // The comment must not claim these vars are surface-gateway only — the api
  // service's self-serve signup (services/api/src/onboarding/email-delivery.ts)
  // reads the same EMAIL_ENDPOINT/EMAIL_API_KEY/EMAIL_FROM vars, gated by
  // BRAIN_SELF_SERVE_SIGNUP instead of EMAIL_ENABLED.
  assert.doesNotMatch(envProdExample, /surface-gateway service only/);
  assert.match(envProdExample, /services\/api\/src\/onboarding\/email-delivery\.ts/);
});
