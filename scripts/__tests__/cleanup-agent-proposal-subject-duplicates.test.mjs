import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  ".github/workflows/ops-cleanup-agent-proposal-subject-duplicates.yml",
  "utf8",
);
const cleanup = readFileSync("scripts/ops/cleanup-agent-proposal-subject-duplicates.mjs", "utf8");

test("cleanup recognizes reconciliation transaction subjects", () => {
  assert.match(
    cleanup,
    /p\.proposing_agent IN \('reconciliation', 'subscription', 'fraud_anomaly'\)/,
  );
  assert.match(
    cleanup,
    /group\.proposing_agent === "reconciliation"[\s\S]*field === "transaction_id"/,
  );
  assert.match(cleanup, /ORDER BY created_at DESC, id DESC[\s\S]*FOR UPDATE/);
});

test("apply is tenant and agent scoped and preserves supersede history", () => {
  assert.match(cleanup, /apply requires both tenant-id and agent-id/);
  assert.match(cleanup, /\(\$1::text IS NULL OR p\.tenant_id = \$1\)/);
  assert.match(cleanup, /\(\$2::text IS NULL OR p\.proposing_agent = \$2\)/);
  assert.match(cleanup, /SET status = 'superseded'/);
  assert.match(cleanup, /superseded_at = now\(\)/);
  assert.match(cleanup, /superseded_by = \$2/);
  assert.match(cleanup, /action: "agent\.action\.superseded"/);
  assert.match(cleanup, /original_proposed_audit_subjects/);
  assert.match(cleanup, /cleanup_audit_subjects/);
  assert.match(cleanup, /proposal or cleanup audit preservation verification failed/);
  assert.doesNotMatch(cleanup, /DELETE FROM proposals|TRUNCATE proposals/);
});

test("workflow is true-production gated and requires explicit apply confirmation", () => {
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /tenant_id:/);
  assert.match(workflow, /agent_id:/);
  assert.match(workflow, /options: \[reconciliation,/);
  assert.match(workflow, /VM_ENV_FILE: \.env\.prod/);
  assert.match(workflow, /API_BASE: https:\/\/api\.brain\.fi/);
  assert.match(workflow, /scripts\/ops\/assert-true-production\.sh/);
  assert.match(workflow, /SUPERSEDE_DUPLICATE_AGENT_PROPOSAL_SUBJECT_DUPLICATES/);
  assert.match(workflow, /--tenant-id "\$TENANT_ID" --agent-id "\$AGENT_ID"/);
});

test("workflow remote script has valid Bash syntax", () => {
  const remoteScriptMatch = workflow.match(/<<'REMOTE'\n([\s\S]*?)\n          REMOTE\n/);
  assert.ok(remoteScriptMatch, "expected fixed remote cleanup script");
  const remoteScript = remoteScriptMatch[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n"], { input: remoteScript, stdio: "pipe" });
  });
});
