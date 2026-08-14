import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(
  process.cwd(),
  ".github/workflows/ops-delete-staging-exhausted-trust-gate-fixture.yml",
);

test("exhausted trust-gate fixture deletion is fixed to the known staging-only tenant", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /VM_HOST_STAGING/);
  assert.doesNotMatch(workflow, /environment:\s*production/);
  assert.match(workflow, /tnt_01KZX2QQZVES2W2Y05AJHKCGQ0/);
  assert.match(workflow, /pi_01KZX2QVAXXX3855S4E7HFCJF0/);
  assert.match(workflow, /exo_01KZX2QW53P9MQGJZEZ02GZBC9/);
  assert.match(workflow, /outbox_attempt_count === 12/);
  assert.match(workflow, /outbox_execution_id === null/);
  assert.match(workflow, /outbox_rail_receipt === null/);
  assert.match(workflow, /DELETE \"\$API_BASE\/v1\/tenants\/\$tenant_id\"/);
  assert.match(workflow, /fixture_delete_postflight/);
  assert.match(workflow, /exhausted_trust_gate_fixture_delete_complete/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*inputs:/);
});
