import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/ops-cors-allowed-origins.yml");

test("CORS transition workflow is target-bounded and production-gated", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /target:\n\s+description: "Deploy target/);
  assert.match(workflow, /type: choice/);
  assert.match(workflow, /- staging/);
  assert.match(workflow, /- production/);
  assert.match(
    workflow,
    /environment: \$\{\{ inputs\.target == 'production' && 'production' \|\| 'staging' \}\}/,
  );
  assert.match(
    workflow,
    /VM_ENV_FILE: \$\{\{ inputs\.target == 'production' && '\.env\.prod' \|\| '\.env\.staging' \}\}/,
  );
  assert.doesNotMatch(workflow, /inputs\.(?:origin|command|env_file)/);
});

test("CORS transition workflow preserves origins, restarts only API, and verifies preflight", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /required_origin = "https:\/\/app\.brain\.fi"/);
  assert.match(workflow, /if required_origin in origins:/);
  assert.match(workflow, /origins\.append\(required_origin\)/);
  assert.match(workflow, /os\.replace\(temporary, path\)/);
  assert.match(workflow, /up -d --no-deps --no-build --force-recreate api/);
  assert.doesNotMatch(workflow, /--force-recreate api worker agents surface-gateway/);
  assert.match(workflow, /Origin: https:\/\/app\.brain\.fi/);
  assert.match(workflow, /Access-Control-Request-Method: GET/);
  assert.match(workflow, /access-control-allow-origin: https:\/\/app\.brain\.fi/);
  assert.match(workflow, /access-control-allow-credentials: true/);
});
