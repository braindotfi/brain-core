import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("main applies the tenant-deletion role before coverage uses it", () => {
  const workflow = readFileSync(".github/workflows/main.yml", "utf8");
  const roleSetup = workflow.indexOf(
    "- name: Apply DB role model for least-privilege integration tests",
  );
  const coverage = workflow.indexOf("- run: pnpm run test:coverage", roleSetup);

  assert.notEqual(roleSetup, -1);
  assert.notEqual(coverage, -1);
  assert.ok(roleSetup < coverage);
  assert.match(
    workflow.slice(roleSetup, coverage),
    /brain_tenant_deletion_password="brain_tenant_deletion"/,
  );
});
