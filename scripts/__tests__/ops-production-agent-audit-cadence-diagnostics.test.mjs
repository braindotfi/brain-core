import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  ".github/workflows/ops-production-agent-audit-cadence-diagnostics.yml",
  "utf8",
);
const report = readFileSync("scripts/ops/report-agent-audit-cadence.sql", "utf8");

test("agent audit cadence diagnostics is fixed to true production", () => {
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /VM_ENV_FILE: \.env\.prod/);
  assert.match(workflow, /API_BASE: https:\/\/api\.brain\.fi/);
  assert.match(workflow, /DIAGNOSE_AGENT_AUDIT_CADENCE_TRUE_PRODUCTION/);
  assert.match(workflow, /scripts\/ops\/assert-true-production\.sh/);
  assert.match(workflow, /bash \/tmp\/assert-true-production\.sh/);
  assert.doesNotMatch(workflow, /\.env\.staging|api\.staging\.brain\.fi/);
});

test("agent audit cadence diagnostics runs a bounded read-only tenant report", () => {
  assert.match(report, /BEGIN TRANSACTION READ ONLY/);
  assert.match(report, /SET LOCAL statement_timeout = '10s'/);
  assert.match(report, /WHERE tenant_id = :'tenant_id'/);
  assert.match(report, /action = 'agent.action.refreshed'/);
  assert.match(report, /actor = 'vendor_risk'/);
  assert.match(report, /FROM agent_trigger_cooldowns/);
  assert.doesNotMatch(report, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
});
