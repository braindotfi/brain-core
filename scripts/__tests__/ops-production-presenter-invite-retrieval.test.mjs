import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(
  process.cwd(),
  ".github/workflows/ops-production-retrieve-presenter-invite.yml",
);
const SHELL_SCRIPT = join(
  process.cwd(),
  "scripts/ops/retrieve-production-presenter-invite.sh",
);

test("presenter invite retrieval is fixed to true production", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const shellScript = readFileSync(SHELL_SCRIPT, "utf8");

  assert.match(workflow, /environment: production/);
  assert.match(workflow, /VM_ENV_FILE: \.env\.prod/);
  assert.match(workflow, /API_BASE: https:\/\/api\.brain\.fi/);
  assert.match(workflow, /assert-true-production\.sh/);
  assert.doesNotMatch(workflow, /\.env\.staging|api\.staging\.brain\.fi/);
  assert.match(shellScript, /tnt_01M0KHRVY3RT3EXN7WT2SPDFMZ/);
  assert.match(shellScript, /braindotfi@gmail\.com/);
});

test("retrieval verifies the retained token and returns ciphertext only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  const shellScript = readFileSync(SHELL_SCRIPT, "utf8");

  assert.match(shellScript, /stat -c '%a'/);
  assert.match(shellScript, /sha256sum "\$token_path"/);
  assert.match(shellScript, /value\.valid_now === true/);
  assert.match(shellScript, /rsa_padding_mode:oaep/);
  assert.match(shellScript, /rsa_oaep_md:sha256/);
  assert.match(shellScript, /invite_ciphertext=/);
  assert.doesNotMatch(shellScript, /cat "\$token_path"|printf.*\$token_path/);
  assert.match(workflow, /"\$\{#ciphertext\}" == "684"/);
  assert.match(workflow, /base64 -d \| wc -c/);
});
