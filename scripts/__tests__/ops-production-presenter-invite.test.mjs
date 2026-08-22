import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/ops-production-issue-presenter-invite.yml");
const SHELL_SCRIPT = join(process.cwd(), "scripts/ops/issue-production-presenter-invite.sh");
const NODE_SCRIPT = join(process.cwd(), "scripts/ops/issue-production-presenter-invite.mjs");

test("presenter invite issuance is fixed to the true production tenant", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const shellScript = readFileSync(SHELL_SCRIPT, "utf8");
  const nodeScript = readFileSync(NODE_SCRIPT, "utf8");

  assert.match(workflow, /environment: production/);
  assert.match(workflow, /VM_HOST: \$\{\{ secrets\.VM_HOST \}\}/);
  assert.match(workflow, /VM_ENV_FILE: \.env\.prod/);
  assert.match(workflow, /API_BASE: https:\/\/api\.brain\.fi/);
  assert.match(workflow, /assert-true-production\.sh/);
  assert.doesNotMatch(workflow, /VM_HOST_STAGING|\.env\.staging|api\.staging\.brain\.fi/);

  for (const source of [shellScript, nodeScript]) {
    assert.match(source, /tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ/);
    assert.match(source, /braindotfi@gmail\.com/);
    assert.doesNotMatch(source, /tnt_01M0DBPNXG0TRB0SV1WTMB6F6J|braindotfi\+test[2-6]@gmail\.com/);
  }
});

test("presenter invite is admin, full-access, valid, and audited", () => {
  const shellScript = readFileSync(SHELL_SCRIPT, "utf8");
  const nodeScript = readFileSync(NODE_SCRIPT, "utf8");

  assert.match(nodeScript, /role: "admin"/);
  assert.match(nodeScript, /"ap", "ar", "treasury", "payroll", "reconciliation"/);
  assert.match(nodeScript, /per_item_limit_cents: "100000000"/);
  assert.match(nodeScript, /requires_second_approver_above_cents: null/);
  assert.match(nodeScript, /event\?\.action === "member\.changed"/);
  assert.match(nodeScript, /event\?\.action === "member\.invited"/);

  assert.match(shellScript, /value\.tenant_kind === "production"/);
  assert.match(shellScript, /value\.sandbox === false/);
  assert.match(shellScript, /value\.status === "invited"/);
  assert.match(shellScript, /value\.consumed_at === null/);
  assert.match(shellScript, /value\.revoked_at === null/);
  assert.match(shellScript, /value\.valid_now === true/);
});

test("presenter invite plaintext is retained only in mode-0600 files", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const shellScript = readFileSync(SHELL_SCRIPT, "utf8");
  const nodeScript = readFileSync(NODE_SCRIPT, "utf8");

  assert.match(nodeScript, /writeFileSync\(TOKEN_PATH, inviteToken/);
  assert.match(nodeScript, /chmodSync\(TOKEN_PATH, 0o600\)/);
  assert.doesNotMatch(nodeScript, /stdout\.write\(inviteToken\)|console\.log\(inviteToken\)/);
  assert.match(shellScript, /host_secret_dir="\/home\/azureuser\/\.brain-secrets"/);
  assert.match(shellScript, /chmod 600 "\$host_token_path" "\$host_metadata_path"/);
  assert.match(shellScript, /sha256sum "\$host_token_tmp"/);
  assert.doesNotMatch(shellScript, /cat "\$host_token_path"|printf.*\$inviteToken/);
  assert.doesNotMatch(workflow, /invite_ciphertext=/);
});
