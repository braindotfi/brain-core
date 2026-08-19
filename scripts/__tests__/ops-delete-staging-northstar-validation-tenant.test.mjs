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

test("Northstar validation tenant cleanup is fixed to staging and accepts only its synthetic bootstrap link", async () => {
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
  assert.match(script, /SET LOCAL statement_timeout = '15s'/);
  assert.doesNotMatch(script, /statement_timeout = '15 seconds'/);
  assert.match(script, /X-Platform-Service-Auth/);
  assert.match(script, /\/internal\/brain-identities\/\$TENANT_ID/);
  assert.match(script, /parsed\?\.linked !== false/);
  assert.match(script, /tenant_created_via/);
  assert.match(script, /seed_marker_count/);
  assert.match(script, /identity_link_summary/);
  assert.match(script, /all_links_belong_to_tenant/);
  assert.match(script, /synthetic_bootstrap_link_count/);
  assert.match(script, /linked_member_is_active_synthetic_bootstrap_admin/);
  assert.match(script, /northstar-phase4\\\\\+\[0-9a-f\]\{32\}@brain/);
  assert.match(script, /northstar-phase4:\[0-9a-f\]\{32\}/);
  assert.doesNotMatch(script, /:'tenant_id'|:'seed_key'/);
  assert.match(script, /deletedRows\?\.tenants !== 1/);
  assert.match(script, /tenant\.deleted/);
});
