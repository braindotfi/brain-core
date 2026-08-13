import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/ops-staging-trust-gate-controlled-smoke.yml");

test("controlled trust-gate smoke is staging-only and restores the process flag", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /^name: ops-staging-trust-gate-controlled-smoke$/m);
  assert.match(workflow, /VM_HOST_STAGING/);
  assert.doesNotMatch(workflow, /secrets\.VM_HOST(?!_STAGING)/);
  assert.doesNotMatch(workflow, /environment:\s*production/);
  assert.match(workflow, /runtime_flag_before=false/);
  assert.match(workflow, /runtime_flag_enabled_api=true/);
  assert.match(workflow, /runtime_flag_after_api=false/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /output\.append\(f"\{key\}=true"\)/);
  assert.match(workflow, /output\.append\(f"\{key\}=false"\)/);
});

test("controlled trust-gate smoke exercises the denial matrix without rail dispatch", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /expect_execute_failure paused/);
  assert.match(workflow, /counterparty_trust_paused/);
  assert.match(workflow, /expect_execute_failure missing_counterparty/);
  assert.match(workflow, /counterparty not found/);
  assert.match(workflow, /expect_execute_failure trusted/);
  assert.match(workflow, /expect_execute_failure unreviewed/);
  assert.match(workflow, /expect_execute_failure acknowledged/);
  assert.match(workflow, /execution_outbox/);
  assert.match(workflow, /smoke_outbox_rows=0/);
  assert.match(workflow, /payment_intent\.execute\.after/);
  assert.match(workflow, /trust_gate_window_start/);
  assert.match(workflow, /trust_gate_window_end/);
});
