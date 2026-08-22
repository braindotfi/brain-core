import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/ops-production-issue-test6-invite.yml");
const SHELL_SCRIPT = join(process.cwd(), "scripts/ops/issue-production-test6-invite.sh");
const NODE_SCRIPT = join(process.cwd(), "scripts/ops/issue-production-test6-invite.mjs");

test("test6 invite issuance is fixed to the true production tenant", () => {
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
    assert.match(source, /braindotfi\+test6@gmail\.com/);
    assert.doesNotMatch(source, /tnt_01M0DBPNXG0TRB0SV1WTMB6F6J|test[2-5]@gmail\.com/);
  }
});

test("test6 invite is admin, full-access, valid, and audited", () => {
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

test("test6 plaintext is encrypted to the pinned ephemeral public key", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const shellScript = readFileSync(SHELL_SCRIPT, "utf8");
  const nodeScript = readFileSync(NODE_SCRIPT, "utf8");

  assert.match(nodeScript, /9862158de969b874ca02ed2ea63acbfe8c7dc954f3ebc12391ac4759cd03e12a/);
  assert.match(nodeScript, /RSA_PKCS1_OAEP_PADDING/);
  assert.match(nodeScript, /oaepHash: "sha256"/);
  assert.match(nodeScript, /process\.stdout\.write\(ciphertext\)/);
  assert.doesNotMatch(nodeScript, /process\.stdout\.write\(inviteToken\)/);
  assert.match(shellScript, /"\$\{#ciphertext\}" != "684"/);
  assert.match(shellScript, /base64 -d \| wc -c/);
  assert.match(workflow, /"\$\{#ciphertext\}" == "684"/);
  assert.match(workflow, /base64 -d \| wc -c/);
});
