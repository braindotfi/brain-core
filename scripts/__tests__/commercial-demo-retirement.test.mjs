import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const execution = readFileSync("scripts/ops/execute-commercial-demo-retirement.mjs", "utf8");
const runner = readFileSync("scripts/ops/run-commercial-demo-retirement.sh", "utf8");
const workflow = readFileSync(".github/workflows/ops-delete-orphan-demo-tenants.yml", "utf8");

test("commercial demo retirement is pinned to the approved cohort", () => {
  for (const source of [execution, runner]) {
    assert.match(source, /bb1b86215c7676d4587db4fe50191610d169f46fd57125b2623347f1223efad8/);
    assert.match(source, /1519/);
  }
  assert.match(runner, /318e3d485df905a326256e70de360bd1cf769437e1cce084719f12ef66b521e7/);
});

test("commercial demo retirement protects every approved denylist tenant", () => {
  const protectedIds = [
    "tnt_00000000010000000000000000",
    "tnt_01KYAT7A1QRKHTYW9H4RAR2SEX",
    "tnt_01KYAT31JH0G043K77H8SKYG4N",
    "tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ",
    "tnt_01M1GTBQN8R8PB6X6PN73YB6NP",
    "tnt_01M1M64ZE1R8J9TB6C3DCRKA61",
  ];
  for (const id of protectedIds) {
    assert.ok(execution.includes(id), `execution denylist must contain ${id}`);
    assert.ok(runner.includes(id), `runner denylist must contain ${id}`);
  }
});

test("commercial demo retirement stays fail closed and transactionally audited", () => {
  assert.match(execution, /BEGIN ISOLATION LEVEL REPEATABLE READ/);
  assert.match(execution, /ROLLBACK/);
  assert.match(execution, /tenant_blob_purge_jobs/);
  assert.match(execution, /tenant_blob_purge_audit_outbox/);
  assert.match(execution, /assertPostDelete/);
  assert.match(runner, /restore_agent_states_after_abort/);
  assert.match(runner, /brain-prod-worker/);
  assert.match(runner, /brain-prod-agents/);
  assert.match(runner, /QUIET_WINDOW_SECONDS=120/);
  assert.match(runner, /QUIET_POLL_SECONDS=15/);
  assert.match(runner, /QUIET_TIMEOUT_SECONDS=900/);
  assert.match(runner, /wait_for_candidate_quiescence/);
  assert.match(runner, /commercial_demo_retirement_quiet_window_reset/);
  assert.match(runner, /pre-fence-cohort\.log/);
  assert.match(runner, /final-preflight\.log/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /production-tenant-deletion/);
});
