import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const WORKFLOW = join(process.cwd(), ".github/workflows/staging-diagnostics.yml");

test("staging tenant identity lookup is fixed, validated, and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /tenant-identity-lookup/);
  assert.match(workflow, /Exact platform user UUID or email/);
  assert.match(workflow, /requires an exact UUID or email/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /member_identity_links l/);
  assert.match(workflow, /tenant\.created', 'tenant\.demo_seeded/);
  assert.match(workflow, /^ {10}SQL$/m);
  assert.match(workflow, /^ {10}REMOTE$/m);
  assert.doesNotMatch(workflow, /arbitrary SQL/i);
});
