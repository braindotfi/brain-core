import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const migration = await readFile(
  "services/api/migrations/0044_commercial_shadow_daily_operations.sql",
  "utf8",
);
const roles = await readFile("infra/db-roles.sql", "utf8");
const runner = await readFile("scripts/ops/run-commercial-shadow-scheduler.sh", "utf8");
const dailyTimer = await readFile("infra/systemd/brain-commercial-shadow-daily.timer", "utf8");
const heartbeatTimer = await readFile(
  "infra/systemd/brain-commercial-shadow-heartbeat.timer",
  "utf8",
);
const operator = await readFile(".github/workflows/ops-commercial-shadow-scheduler.yml", "utf8");
const report = await readFile(".github/workflows/commercial-shadow-daily-report.yml", "utf8");
const workload = await readFile("services/api/src/commercial/shadow-daily.ts", "utf8");

test("daily run evidence is tenant-scoped, append-only, and function-gated", () => {
  assert.match(migration, /CREATE TABLE commercial_shadow_daily_runs/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /commercial_shadow_daily_runs_immutable_row/);
  assert.match(migration, /commercial_shadow_daily_runs_immutable_truncate/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION record_internal_commercial_shadow_daily_run/);
  assert.match(migration, /PERFORM assert_internal_commercial_shadow_zero_billing/);
  assert.match(migration, /enforcement_applied = FALSE/);
  assert.match(migration, /commercial_shadow_completion_requires_daily_runs/);
  assert.match(migration, /30 complete scheduler-backed daily runs are required/);
  assert.match(roles, /REVOKE ALL PRIVILEGES ON commercial_shadow_daily_runs/);
  assert.match(roles, /GRANT SELECT ON commercial_shadow_daily_runs TO brain_privileged/);
  assert.doesNotMatch(roles, /GRANT INSERT ON commercial_shadow_daily_runs/);
});

test("driver uses exact weekday and weekend volumes over real credential paths", () => {
  assert.match(workload, /\{ api: 500, mcp: 50 \}/);
  assert.match(workload, /\{ api: 1000, mcp: 100 \}/);
  assert.match(workload, /COMMERCIAL_SHADOW_FIRST_RUN_DATE = "2026-10-01"/);
  assert.match(workload, /COMMERCIAL_SHADOW_LAST_RUN_DATE_EXCLUSIVE = "2026-11-01"/);
  assert.match(workload, /https:\/\/api\.brain\.fi/);
  assert.match(workload, /https:\/\/auth\.brain\.fi\/token/);
  assert.match(workload, /https:\/\/mcp\.brain\.fi\//);
  assert.match(workload, /urn:ietf:params:oauth:grant-type:token-exchange/);
  assert.match(workload, /scope: SHADOW_MCP_SCOPES/);
  assert.match(workload, /api_gateway_request_observations/);
  assert.match(workload, /mcp_transport_tool_observations/);
});

test("scheduler has a fixed UTC run and a fresh heartbeat loop", () => {
  assert.match(dailyTimer, /OnCalendar=\*-\*-\* 01:15:00 UTC/);
  assert.match(dailyTimer, /Persistent=true/);
  assert.match(heartbeatTimer, /OnUnitActiveSec=5m/);
  assert.match(runner, /assert-true-production\.sh/);
  assert.match(runner, /curl -fsS https:\/\/api\.brain\.fi\/health/);
  assert.match(runner, /json\.load\(sys\.stdin\)\["commit"\]/);
  assert.doesNotMatch(runner, /git rev-parse HEAD/);
  assert.match(runner, /systemctl is-failed --quiet brain-commercial-shadow-daily\.service/);
  assert.match(runner, /--state "\$heartbeat_state"/);
  assert.match(runner, /:ro/);
  assert.doesNotMatch(runner, /cat .*credentials/);
});

test("scheduler mutations use exact confirmations and production review", () => {
  assert.match(operator, /environment: production/);
  assert.match(operator, /INSPECT_COMMERCIAL_SHADOW_SCHEDULER/);
  assert.match(operator, /INSTALL_COMMERCIAL_SHADOW_SCHEDULER/);
  assert.match(operator, /DISABLE_COMMERCIAL_SHADOW_SCHEDULER/);
  assert.match(operator, /ref: \$\{\{ inputs\.approved_sha \}\}/);
  assert.match(operator, /scp -i ~\/\.ssh\/id_deploy/);
  assert.match(operator, /scripts\/ops\/run-commercial-shadow-scheduler\.sh/);
  assert.match(operator, /REMOTE_ASSET_DIR/);
  assert.match(operator, /install -o azureuser -g azureuser -m 0755/);
  assert.match(operator, /sudo install -o root -g root -m 0644/);
  assert.match(operator, /systemctl enable --now brain-commercial-shadow-daily\.timer/);
});

test("scheduled report surfaces missing evidence and creates one alert issue", () => {
  assert.match(report, /cron: "0 4 \* \* \*"/);
  assert.match(report, /commercial\/shadow-daily-cli\.js report/);
  assert.match(report, /status != "complete"/);
  assert.match(report, /scheduler\.get\("fresh"\) is not True/);
  assert.match(report, /gh issue create/);
  assert.match(report, /exit 1/);
});
