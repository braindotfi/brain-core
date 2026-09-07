import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(
  process.cwd(),
  ".github/workflows/ops-set-production-self-serve-signup-disabled.yml",
);

test("production self-serve signup workflow is narrowly gated", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: promote-prod/);
  assert.match(workflow, /SET_PRODUCTION_SELF_SERVE_SIGNUP_FALSE/);
  assert.doesNotMatch(workflow, /inputs\.(?:key|value|command|env_file)/);
});

test("production self-serve signup workflow can only write false and restarts only API", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /key=BRAIN_SELF_SERVE_SIGNUP/);
  assert.match(workflow, /print key "=false"/);
  assert.match(workflow, /grep -qx "\$\{key\}=false"/);
  assert.match(workflow, /up -d --no-deps --no-build --force-recreate api/);
  assert.doesNotMatch(workflow, /--force-recreate (?:worker|agents|surface-gateway)/);
  assert.match(workflow, /self_serve_signup_runtime_value=false/);
});

test("production self-serve signup remote script has valid Bash syntax", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const remoteScriptMatch = workflow.match(/<<'REMOTE'\n([\s\S]*?)\n          REMOTE\n/);
  assert.ok(remoteScriptMatch, "expected fixed remote configuration script");
  const remoteScript = remoteScriptMatch[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");

  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n"], { input: remoteScript, stdio: "pipe" });
  });
});
