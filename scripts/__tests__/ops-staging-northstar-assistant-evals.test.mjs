import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, ".github/workflows/ops-staging-northstar-assistant-evals.yml");
const SCRIPT = join(ROOT, "scripts/ops/run-northstar-assistant-evals.mjs");
const REMOTE_SCRIPT = join(ROOT, "scripts/ops/run-northstar-assistant-evals.sh");

test("Northstar Assistant evaluation is fixed to staging and the canonical tenant", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const script = readFileSync(SCRIPT, "utf8");
  const remote = readFileSync(REMOTE_SCRIPT, "utf8");

  assert.match(workflow, /^name: ops-staging-northstar-assistant-evals$/m);
  assert.match(workflow, /VM_HOST_STAGING/);
  assert.doesNotMatch(workflow, /secrets\.VM_HOST(?!_STAGING)/);
  assert.doesNotMatch(workflow, /environment:\s*production/);
  assert.match(workflow, /northstar_assistant_evals_completed/);
  assert.match(workflow, /grep -c '\^\{'/);
  assert.match(script, /const TENANT_ID = "tnt_01M08J9B75QH08MCVA884N57VB"/);
  assert.match(script, /"\/sessions"/);
  assert.match(script, /"\/wiki\/question"/);
  assert.match(script, /questions\.length !== 34/);
  assert.match(remote, /BEGIN TRANSACTION READ ONLY/);
  assert.match(remote, /readonly tenant_id="tnt_01M08J9B75QH08MCVA884N57VB"/);
  assert.match(remote, /docker exec brain-prod-api rm -f/);
});
