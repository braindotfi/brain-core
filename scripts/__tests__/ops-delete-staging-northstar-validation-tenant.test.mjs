import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/ops-delete-staging-northstar-validation-tenant.yml", import.meta.url),
);
const scriptPath = fileURLToPath(
  new URL("../ops/delete-staging-northstar-validation-tenant.sh", import.meta.url),
);

test("Northstar validation tenant cleanup is fixed to staging and fails closed on identity links", async () => {
  const [workflow, script] = await Promise.all([
    readFile(workflowPath, "utf8"),
    readFile(scriptPath, "utf8"),
  ]);

  assert.match(workflow, /^name: ops-delete-staging-northstar-validation-tenant$/m);
  assert.match(workflow, /VM_HOST_STAGING/);
  assert.doesNotMatch(workflow, /environment:\s*production/);
  assert.match(workflow, /DELETE_NORTHSTAR_STAGING_VALIDATION_TENANT/);
  assert.match(workflow, /northstar_validation_tenant_preflight_completed/);
  assert.match(workflow, /northstar_validation_tenant_delete_completed/);

  assert.match(script, /readonly TENANT_ID='tnt_01M0909Z6WCCPB4MG0SWJ07VJX'/);
  assert.match(script, /BEGIN TRANSACTION READ ONLY/);
  assert.match(script, /X-Platform-Service-Auth/);
  assert.match(script, /\/internal\/brain-identities\/\$TENANT_ID/);
  assert.match(script, /parsed\?\.linked !== false/);
  assert.match(script, /tenant_created_via/);
  assert.match(script, /seed_marker_count/);
  assert.doesNotMatch(script, /:'tenant_id'|:'seed_key'/);
  assert.match(script, /deletedRows\?\.tenants !== 1/);
  assert.match(script, /tenant\.deleted/);
});
