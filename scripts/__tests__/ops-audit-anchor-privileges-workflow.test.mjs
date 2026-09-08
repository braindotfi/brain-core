import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/ops-audit-anchor-privileges.yml");

const RUNTIME_ROLES = [
  "brain_app",
  "brain_privileged",
  "brain_wiki_reader",
  "brain_mcp_reader",
  "brain_raw_worker",
  "brain_canonical_projector",
  "brain_ledger_projector",
  "brain_execution_worker",
  "brain_audit_verifier",
  "brain_audit_publisher",
  "brain_resolver",
  "brain_tenant_deletion",
  "brain_surface_gateway",
  "brain_surface_audit_writer",
  "brain_auth",
  "brain_auth_audit_writer",
];

test("audit-anchor privilege diagnostic is production-gated and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /environment: production/);
  assert.match(workflow, /Exact deployed commit SHA to verify/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /ROLLBACK;/);
  assert.match(workflow, /has_table_privilege\(role_name, 'audit_anchors', 'DELETE'\)/);
  assert.match(workflow, /has_table_privilege\(role_name, 'audit_anchors', 'TRUNCATE'\)/);
  assert.doesNotMatch(workflow, /GRANT|REVOKE|ALTER TABLE|DELETE FROM|TRUNCATE TABLE/i);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);

  for (const role of RUNTIME_ROLES) {
    assert.match(workflow, new RegExp(`'${role}'`));
  }
});

test("audit-anchor privilege diagnostic preserves required runtime capabilities", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
    assert.match(workflow, new RegExp(`'brain_app', 'audit_anchors', '${privilege}'`));
  }
  for (const privilege of ["SELECT", "UPDATE"]) {
    assert.match(workflow, new RegExp(`'brain_audit_verifier', 'audit_anchors', '${privilege}'`));
  }
  assert.match(workflow, /'brain_audit_publisher', 'audit_anchors', 'SELECT'/);
  assert.match(workflow, /'brain_tenant_deletion', 'audit_anchors', 'SELECT'/);
});

test("remote audit-anchor privilege diagnostic has valid Bash heredoc structure", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const remoteScriptMatch = workflow.match(/<<'REMOTE'\n([\s\S]*?)\n          REMOTE\n/);

  assert.ok(remoteScriptMatch, "expected a fixed remote diagnostic script");
  const remoteScript = remoteScriptMatch[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");

  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n"], { input: remoteScript, stdio: "pipe" });
  });
});
