import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ops-api-entitlements.yml", "utf8");
const shadowWorkflow = readFileSync(".github/workflows/ops-api-usage-shadow.yml", "utf8");
const compose = readFileSync("docker-compose.prod.yml", "utf8");
const routes = readFileSync("services/api/src/production-tenancy/api-key-routes.ts", "utf8");

test("entitlement workflow is protected, tenant-confirmed, and idempotent", () => {
  assert.match(
    workflow,
    /environment: \$\{\{ inputs\.target == 'production' && 'production' \|\| 'staging' \}\}/,
  );
  assert.match(workflow, /confirm_tenant_id must exactly match tenant_id/);
  assert.match(workflow, /github-run-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /scripts\/ops\/assert-true-production\.sh/);
  assert.match(workflow, /--no-deps", "entitlement-operator"/);
});

test("shadow reconcile and close require protected evidence and tenant confirmation", () => {
  assert.match(shadowWorkflow, /options: \[reconcile, close-shadow, adjust\]/);
  assert.match(shadowWorkflow, /confirm_tenant_id must exactly match tenant_id/);
  assert.match(shadowWorkflow, /gateway_request_count/);
  assert.match(shadowWorkflow, /limiter_decision_count/);
  assert.match(shadowWorkflow, /meter_persistence_failures/);
  assert.match(shadowWorkflow, /scripts\/ops\/assert-true-production\.sh/);
  assert.match(shadowWorkflow, /billing-operator-cli\.js/);
});

test("operator one-shot gets split privileged mutation and tenant audit roles", () => {
  assert.match(compose, /entitlement-operator:\n[\s\S]*profiles: \["ops"\]/);
  assert.match(compose, /DATABASE_URL: postgres:\/\/brain_privileged:/);
  assert.match(compose, /BRAIN_AUDIT_DATABASE_URL: postgres:\/\/brain_app:/);
  assert.doesNotMatch(routes, /api_entitlement_change_log/);
  assert.doesNotMatch(routes, /assign-tier|set-key-override|clear-key-override/);
});
