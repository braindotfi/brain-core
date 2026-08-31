import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

test("workflow preserves the Caddy bind mount and has valid shell syntax", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /cp --preserve=mode,ownership,timestamps "\$candidate" "\$source_file"/);
  assert.doesNotMatch(workflow, /mv "\$candidate" "\$source_file"/);
  assert.match(workflow, /--config "\$validation_path"/);
  assert.match(workflow, /already_present_and_reloaded/);

  const verifyStart = workflow.indexOf("      - name: Verify live staging routing");
  const runStart = workflow.indexOf("        run: |\n", verifyStart) + "        run: |\n".length;
  const nextStep = workflow.indexOf(
    "\n      - name: Report redacted staging Slack readiness",
    runStart,
  );
  assert.notEqual(verifyStart, -1);
  assert.notEqual(nextStep, -1);
  const shell = workflow
    .slice(runStart, nextStep)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const syntax = spawnSync("bash", ["-n"], { input: shell, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
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
