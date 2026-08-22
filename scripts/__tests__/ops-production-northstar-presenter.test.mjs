import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(
  process.cwd(),
  ".github/workflows/ops-production-provision-northstar-presenter.yml",
);
const PREFLIGHT = join(process.cwd(), "scripts/ops/assert-true-production.sh");

test("Northstar provisioning is explicitly gated to true production", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const preflight = readFileSync(PREFLIGHT, "utf8");

  assert.match(workflow, /environment: production/);
  assert.match(workflow, /VM_HOST: \$\{\{ secrets\.VM_HOST \}\}/);
  assert.match(workflow, /VM_ENV_FILE: \.env\.prod/);
  assert.match(workflow, /API_BASE: https:\/\/api\.brain\.fi/);
  assert.doesNotMatch(workflow, /VM_HOST_STAGING|\.env\.staging|api\.staging\.brain\.fi/);

  assert.match(preflight, /expected_api_base="https:\/\/api\.brain\.fi"/);
  assert.match(preflight, /expected_env_file="\.env\.prod"/);
  assert.match(preflight, /NODE_ENV/);
  assert.match(preflight, /BRAIN_RESOLVER_DB_URL/);
  assert.match(preflight, /pg_is_in_recovery\(\)/);
  assert.match(preflight, /true_production_preflight_completed/);
});

test("Assistant evaluation uses a separate disposable tenant and leaves the presenter clean", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /Northstar Labs, Inc\./);
  assert.match(workflow, /Northstar Labs Assistant Evaluation disposable/);
  assert.match(workflow, /\[\[ "\$evaluator_tenant_id" != "\$presenter_tenant_id" \]\]/);
  assert.match(
    workflow,
    /BRAIN_TENANT_ID="\$evaluator_tenant_id"[\s\S]*run-northstar-production-assistant-evals\.sh/,
  );
  assert.match(workflow, /presenter_wiki_questions/);
  assert.match(workflow, /presenter_evaluator_events/);
  assert.match(workflow, /presenter_test_events/);
  assert.match(workflow, /value\.presenter_wiki_questions === 0/);
  assert.match(workflow, /value\.presenter_evaluator_events === 0/);
  assert.match(workflow, /value\.presenter_test_events === 0/);
  assert.match(workflow, /value\.evaluator_wiki_questions === 34/);
});

test("Northstar production workflow preserves evidence on a remote failure", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /set \+e\n\s+output="\$\(ssh/);
  assert.match(workflow, /remote_status=\$\?/);
  assert.match(workflow, /printf '%s\\n' "\$output"\n\s+\[\[ "\$remote_status" == "0" \]\]/);
});
