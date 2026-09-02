import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ops-api-entitlements.yml", "utf8");
const shadowWorkflow = readFileSync(".github/workflows/ops-api-usage-shadow.yml", "utf8");
const compose = readFileSync("docker-compose.prod.yml", "utf8");
const routes = readFileSync("services/api/src/production-tenancy/api-key-routes.ts", "utf8");
const billingService = readFileSync("services/api/src/usage/billing-service.ts", "utf8");
const observationMigration = readFileSync(
  "services/api/migrations/0026_api_usage_gateway_observations.sql",
  "utf8",
);

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

test("shadow reconcile derives durable evidence and requires tenant confirmation", () => {
  assert.match(shadowWorkflow, /options: \[reconcile, close-shadow, adjust\]/);
  assert.match(shadowWorkflow, /confirm_tenant_id must exactly match tenant_id/);
  assert.doesNotMatch(shadowWorkflow, /gateway_request_count/);
  assert.doesNotMatch(shadowWorkflow, /limiter_decision_count/);
  assert.doesNotMatch(shadowWorkflow, /meter_persistence_failures/);
  assert.match(shadowWorkflow, /scripts\/ops\/assert-true-production\.sh/);
  assert.match(shadowWorkflow, /billing-operator-cli\.js/);
  assert.match(billingService, /FROM api_gateway_request_observations o/);
  assert.match(billingService, /LEFT JOIN api_request_meter_events m/);
  assert.match(observationMigration, /CREATE TABLE IF NOT EXISTS api_gateway_request_observations/);
  assert.match(
    observationMigration,
    /CREATE TABLE IF NOT EXISTS api_meter_persistence_failure_events/,
  );
});

test("operator one-shot gets split privileged mutation and tenant audit roles", () => {
  assert.match(compose, /entitlement-operator:\n[\s\S]*profiles: \["ops"\]/);
  assert.match(compose, /DATABASE_URL: postgres:\/\/brain_privileged:/);
  assert.match(compose, /BRAIN_AUDIT_DATABASE_URL: postgres:\/\/brain_app:/);
  assert.doesNotMatch(routes, /api_entitlement_change_log/);
  assert.doesNotMatch(routes, /assign-tier|set-key-override|clear-key-override/);
});
