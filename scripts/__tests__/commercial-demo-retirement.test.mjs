import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const execution = readFileSync("scripts/ops/execute-commercial-demo-retirement.mjs", "utf8");
const runner = readFileSync("scripts/ops/run-commercial-demo-retirement.sh", "utf8");
const workflow = readFileSync(".github/workflows/ops-delete-orphan-demo-tenants.yml", "utf8");
const phaseARunner = readFileSync("scripts/ops/run-commercial-demo-retirement-phase-a.sh", "utf8");
const phaseAWorkflow = readFileSync(
  ".github/workflows/ops-commercial-demo-retirement-phase-a.yml",
  "utf8",
);
const privilegeCheck = readFileSync(
  "scripts/ops/check-commercial-demo-retirement-privileges.mjs",
  "utf8",
);
const progressMigration = readFileSync(
  "services/api/migrations/0034_commercial_demo_retirement_progress.sql",
  "utf8",
);
const perTenantRetirement = readFileSync(
  "services/api/src/tenant-deletion/per-tenant-retirement.ts",
  "utf8",
);
const timingRehearsal = readFileSync(
  "scripts/ops/rehearse-commercial-demo-tenant-retirement.mjs",
  "utf8",
);

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
  assert.match(perTenantRetirement, /BEGIN ISOLATION LEVEL READ COMMITTED/);
  assert.match(perTenantRetirement, /SET LOCAL statement_timeout = '30s'/);
  assert.match(perTenantRetirement, /SET LOCAL lock_timeout = '5s'/);
  assert.match(perTenantRetirement, /SET LOCAL idle_in_transaction_session_timeout = '45s'/);
  assert.match(perTenantRetirement, /ROLLBACK/);
  assert.match(execution, /tenant_blob_purge_jobs/);
  assert.match(execution, /tenant_blob_purge_audit_outbox/);
  assert.match(execution, /assertPostDelete/);
  assert.match(execution, /EXPECTED_DEMO_SECOND_APPROVERS = 788/);
  assert.match(execution, /viewer@example\.com/);
  assert.match(execution, /damon@brain\.fi/);
  assert.match(execution, /approved non-bootstrap member preflight failed/);
  assert.match(runner, /restore_agent_states_after_abort/);
  assert.match(runner, /brain-prod-worker/);
  assert.match(runner, /brain-prod-agents/);
  assert.match(runner, /QUIET_WINDOW_SECONDS=120/);
  assert.match(runner, /QUIET_POLL_SECONDS=15/);
  assert.match(runner, /QUIET_TIMEOUT_SECONDS=900/);
  assert.match(runner, /wait_for_candidate_quiescence/);
  assert.match(runner, /clear_rehearsal_outputs/);
  assert.match(runner, /docker exec -u 0 brain-prod-postgres rm -f/);
  assert.match(runner, /commercial_demo_retirement_quiet_window_reset/);
  assert.match(runner, /DATABASE_EXECUTION_WATCHDOG_SECONDS=10800/);
  assert.match(runner, /FENCE_MONITOR_SECONDS=15/);
  assert.match(runner, /commercial_demo_retirement_activity_fence_breached/);
  assert.match(runner, /commercial_demo_retirement_activity_fence_held/);
  assert.match(runner, /candidate_activity_count_since "\$fence_started_at"/);
  assert.match(runner, /check-commercial-demo-retirement-host-overlap\.sh/);
  assert.match(runner, /pre-fence-cohort\.log/);
  assert.match(runner, /final-preflight\.log/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /production-tenant-deletion/);
  assert.match(workflow, /GRANT SELECT ON audit_integrity_findings TO brain_tenant_deletion/);
  assert.match(workflow, /integrity finding grant is broader than SELECT/);
  assert.match(workflow, /unexpectedly has verifier checkpoint access/);
  assert.match(workflow, /timeout-minutes: 210/);
  assert.match(workflow, /Exact promoted commit SHA/);
  assert.match(workflow, /brain-prod-worker restart count is not zero/);
});

test("commercial demo rows use durable one-tenant transactions", () => {
  assert.match(execution, /initializeRetirementProgress/);
  assert.match(execution, /runRetirementTenantAttempt/);
  assert.match(execution, /assertCountSnapshot/);
  assert.match(execution, /commercial_demo_retirement_completed_with_failures/);
  assert.match(runner, /durable_progress_count/);
  assert.match(runner, /restore_targets_from_progress/);
  assert.match(progressMigration, /PRIMARY KEY \(operation_id, tenant_id\)/);
  assert.match(progressMigration, /status IN \('pending', 'running', 'completed', 'failed'\)/);
  assert.match(progressMigration, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(execution, /deleteTableInBatches/);
});

test("Phase A rehearses one real tenant and rolls every change back", () => {
  assert.match(phaseARunner, /rehearse-commercial-demo-tenant-retirement\.mjs/);
  assert.match(timingRehearsal, /MAX_REHEARSAL_MS = 30_000/);
  assert.match(timingRehearsal, /executeOneTenant/);
  assert.match(timingRehearsal, /ROLLBACK/);
  assert.match(timingRehearsal, /rollback_only: true/);
});

test("Phase A keeps one SHA contract and remains read only", () => {
  assert.match(phaseAWorkflow, /EXPECTED_SHA: \$\{\{ inputs\.sha \}\}/);
  assert.match(phaseAWorkflow, /ref: \$\{\{ inputs\.sha \}\}/);
  assert.doesNotMatch(phaseAWorkflow, /runtime_sha|workflow_sha/);
  assert.match(phaseAWorkflow, /environment: production/);
  assert.match(phaseAWorkflow, /production-tenant-deletion/);
  assert.doesNotMatch(phaseARunner, /DELETE\s+FROM/i);
  assert.doesNotMatch(
    phaseARunner,
    /node \/app\/scripts\/ops\/execute-commercial-demo-retirement\.mjs/,
  );
  assert.match(phaseARunner, /check-commercial-demo-retirement-privileges\.mjs/);
  assert.match(privilegeCheck, /BRAIN_TENANT_DELETION_DB_URL/);
  assert.match(privilegeCheck, /BEGIN TRANSACTION READ ONLY/);
  assert.match(privilegeCheck, /assertTenantDeletionPrivilegeContract/);
});

test("Phase A uses the shared exact-match host overlap checker", () => {
  assert.match(phaseARunner, /scripts\/ops\/check-commercial-demo-retirement-host-overlap\.sh/);
  assert.match(
    phaseARunner,
    /bash "\$REMOTE_ROOT\/check-commercial-demo-retirement-host-overlap\.sh"/,
  );
  assert.doesNotMatch(
    phaseARunner,
    /grep -Eiq '\(pg_dump\|pg_basebackup\|backup\|restic\|borg\|azcopy/,
  );
});
