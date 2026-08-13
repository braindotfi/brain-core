import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(
  process.cwd(),
  ".github/workflows/ops-staging-trust-gate-controlled-smoke.yml",
);

test("controlled trust-gate smoke is staging-only and restores the process flag", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /^name: ops-staging-trust-gate-controlled-smoke$/m);
  assert.match(workflow, /VM_HOST_STAGING/);
  assert.doesNotMatch(workflow, /secrets\.VM_HOST(?!_STAGING)/);
  assert.doesNotMatch(workflow, /environment:\s*production/);
  assert.match(workflow, /runtime_flag_before_api=false/);
  assert.match(workflow, /runtime_flag_before_worker=false/);
  assert.match(workflow, /trust_gate_baseline_complete=true/);
  assert.match(workflow, /trust_gate_baseline_remote_complete/);
  assert.match(workflow, /runtime_flag_enabled_api=true/);
  assert.match(workflow, /TRUST_GATE_SMOKE_MUTATION_STARTED=false/);
  assert.match(workflow, /TRUST_GATE_SMOKE_MUTATION_STARTED=true/);
  assert.match(workflow, /if: always\(\) && env\.TRUST_GATE_SMOKE_MUTATION_STARTED == 'true'/);
  assert.match(workflow, /runtime_flag_after_api=%s/);
  assert.match(workflow, /s\/\^runtime_flag_after_api=\/\/p/);
  assert.match(workflow, /output\.append\(f"\{key\}=true"\)/);
  assert.match(workflow, /output\.append\(f"\{key\}=false"\)/);
  assert.match(workflow, /trust_gate_enable_remote_complete/);
  assert.match(workflow, /trust_gate_restore_remote_complete/);
  assert.match(workflow, /trust_gate_matrix_remote_complete/);
  assert.match(workflow, /trust_gate_confirmation_remote_complete/);
  assert.match(workflow, /Staging trust-gate confirmation remote step did not complete/);
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
  assert.match(workflow, /payment_intent_create_request=/);
  assert.match(workflow, /payment_intent_create_response_status=/);
  assert.match(workflow, /payment_intent_create_response=/);
  assert.match(workflow, /payment_intent_approve_request payment_intent_id=/);
  assert.match(workflow, /payment_intent_approve_response_status=/);
  assert.match(workflow, /payment_intent_approve_response=/);
  assert.match(workflow, /payment_intent_execute_request matrix=/);
  assert.match(workflow, /payment_intent_execute_response_status=/);
  assert.match(workflow, /payment_intent_execute_response=/);
  assert.match(workflow, /Expected 200 while approving smoke payment intent/);
  assert.match(workflow, /payment_intent_create_api_log request_id=/);
  assert.match(workflow, /missing_source_account_response_status=/);
  assert.match(workflow, /Expected 404 for a nonexistent source account/);
  assert.match(workflow, /missing_source_account_api_log request_id=/);
  assert.match(workflow, /smoke_source_account_id=/);
  assert.match(workflow, /INSERT INTO ledger_accounts/);
  assert.match(workflow, /fixture_counterparty_reference_removed/);
  assert.match(workflow, /fixture_source_account_reference_removed/);
  assert.match(workflow, /session_replication_role = replica/);
  assert.match(workflow, /docker logs --since 2m brain-prod-api/);
  assert.match(workflow, /for attempt in \$\(seq 1 8\)/);
  assert.match(workflow, /Controlled trust-gate matrix failed with SSH status/);
  assert.match(workflow, /durable payment_intent\.execute\.after events/);
  assert.match(workflow, /Expected five durable payment_intent\.execute\.after events/);
  assert.match(workflow, /SMOKE_TENANT_ID=/);
  assert.match(workflow, /window_non_fixture_execute_after_count/);
  assert.match(workflow, /trust_gate_window_start/);
  assert.match(workflow, /trust_gate_window_end/);
  assert.match(workflow, /docker exec -w \/app\/services\/api -e SMOKE_TENANT_ID/);
  assert.doesNotMatch(workflow, /docker exec -i brain-prod-postgres psql[^\n]*-c/);
});
