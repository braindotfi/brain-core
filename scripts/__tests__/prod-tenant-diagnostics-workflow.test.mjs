import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/prod-tenant-diagnostics.yml");
const COMPLIANCE_SOURCE_REFS_REPORT = join(
  process.cwd(),
  "scripts/ops/report-compliance-proposal-source-refs.sql",
);

test("ingestion lineage diagnostic is fixed-shape and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /ingestion_lineage:/);
  assert.match(workflow, /INGESTION_LINEAGE/);
  assert.match(workflow, /ingestion_lineage must be true or false/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /raw artifacts and projection status/);
  assert.match(workflow, /parsed extraction payloads/);
  assert.match(workflow, /raw interpretation outcomes/);
  assert.match(workflow, /document extraction job outcomes/);
  assert.match(workflow, /canonical projection log/);
  assert.match(workflow, /ledger invoices/);
  assert.match(workflow, /ledger obligations/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
  assert.doesNotMatch(workflow, /arbitrary SQL/i);
});

test("trust-gate impact diagnostic is production-gated, fixed-shape, and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /trust_gate_impact:/);
  assert.match(workflow, /trust_gate_impact must be true or false/);
  assert.match(workflow, /trust_gate_impact is cross-tenant and requires tenant_id to be empty/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /JOIN tenants t ON t\.id = cp\.owner_id/);
  assert.match(workflow, /non_demo_review_groups/);
  assert.match(workflow, /demo_or_sandbox_groups/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
  assert.doesNotMatch(workflow, /arbitrary SQL/i);
});

test("Compliance source_refs diagnostic is fixed-shape and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const report = readFileSync(COMPLIANCE_SOURCE_REFS_REPORT, "utf8");

  assert.match(workflow, /compliance_source_refs_report:/);
  assert.match(workflow, /COMPLIANCE_SOURCE_REFS_REPORT/);
  assert.match(workflow, /compliance_source_refs_report must be true or false/);
  assert.match(workflow, /report-compliance-proposal-source-refs\.sql/);
  assert.match(report, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(report, /policy_decisions pd/);
  assert.match(report, /proposals_with_non_empty_source_refs/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
  assert.doesNotMatch(workflow, /arbitrary SQL/i);
});

test("remote diagnostics script has valid Bash heredoc structure", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const remoteScriptMatch = workflow.match(/<<'REMOTE'\n([\s\S]*?)\n          REMOTE\n/);

  assert.ok(remoteScriptMatch, "expected the fixed remote diagnostics script");
  const remoteScript = remoteScriptMatch[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");

  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n"], { input: remoteScript, stdio: "pipe" });
  });
});
