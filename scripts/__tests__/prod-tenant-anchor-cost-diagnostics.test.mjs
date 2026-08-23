import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/prod-tenant-anchor-cost-diagnostics.yml", "utf8");
const report = readFileSync("scripts/ops/report-tenant-anchor-cost.sql", "utf8");

test("anchor cost diagnostics are tenant scoped and read only", () => {
  assert.match(workflow, /tenant_id:/);
  assert.match(workflow, /scripts\/ops\/assert-true-production\.sh/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY/);
  assert.match(report, /BEGIN TRANSACTION READ ONLY/);
  assert.match(report, /WHERE tenant_id = :'tenant_id'/);
  assert.doesNotMatch(report, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/);
});

test("report measures roots, shared transaction batches, and corrected rate", () => {
  assert.match(report, /confirmed_roots/);
  assert.match(report, /distinct_anchor_transactions/);
  assert.match(report, /batch_roots/);
  assert.match(report, /reconciliation_duplicate/);
  assert.match(report, /proposal\.id = ae\.inputs->>'proposal_id'/);
  assert.match(report, /proposal\.action->>'transaction_id'/);
  assert.match(report, /unchanged_refresh/);
  assert.match(report, /refresh\.distinct_inputs = 1/);
  assert.match(report, /refresh\.distinct_outputs = 1/);
  assert.match(report, /bug_only_roots/);
  assert.match(report, /projected_corrected_roots_per_day/);
  assert.match(workflow, /eth_getTransactionReceipt/);
  assert.match(workflow, /attributed_gas/);
  assert.match(workflow, /attributed_fee_wei/);
});

test("workflow remote script has valid Bash syntax", () => {
  const remoteScriptMatch = workflow.match(/<<'REMOTE'\n([\s\S]*?)\n          REMOTE\n/);
  assert.ok(remoteScriptMatch, "expected fixed remote diagnostic script");
  const remoteScript = remoteScriptMatch[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n"], { input: remoteScript, stdio: "pipe" });
  });
});
