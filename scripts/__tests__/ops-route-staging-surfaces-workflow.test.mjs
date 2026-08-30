import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/ops-route-staging-surfaces.yml");

test("staging surface routing workflow is target fixed and gated", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /VM_HOST: \$\{\{ secrets\.VM_HOST_STAGING \}\}/);
  assert.match(workflow, /Type staging-surface-route/);
  assert.doesNotMatch(workflow, /VM_HOST_PRODUCTION|\.env\.prod|environment: production/);
});

test("workflow validates, backs up, reloads, and live probes the route", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /caddy validate/);
  assert.match(workflow, /Caddyfile\.backup/);
  assert.match(workflow, /rollback/);
  assert.match(workflow, /caddy reload/);
  assert.match(workflow, /\/surfaces\/slack\/oauth\/callback/);
  assert.match(workflow, /\/surfaces\/slack\/interactions/);
  assert.match(workflow, /\/surfaces\/slack\/events/);
  assert.match(workflow, /auth_token_missing/);
});

test("workflow resolves staging containers from Compose services", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /docker compose -p brain-staging --env-file \.env\.staging/);
  assert.match(workflow, /ps -q caddy/);
  assert.match(workflow, /ps -q surface-gateway/);
  assert.doesNotMatch(workflow, /docker exec brain-prod-(?:caddy|surface-gateway)/);
});

test("workflow reports Slack secret presence without printing values", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  for (const name of [
    "SLACK_SIGNING_SECRET",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_INSTALL_STATE_SECRET",
    "BRAIN_SURFACE_ACTION_SECRET",
  ]) {
    assert.match(workflow, new RegExp(name));
  }
  assert.match(workflow, /printf '%s=present/);
  assert.match(workflow, /printf '%s=unset/);
});
