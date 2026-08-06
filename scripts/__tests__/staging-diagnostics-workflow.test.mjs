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

test("staging Wiki question trace is tenant-bounded, selector-bounded, and read-only", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  assert.match(workflow, /wiki-question-trace/);
  assert.match(workflow, /requires exactly one canonical tenant id/);
  assert.match(workflow, /requires an event id, timestamp bound, or question search/);
  assert.match(workflow, /wiki_question_search must be 160 characters or less/);
  assert.match(workflow, /BEGIN TRANSACTION READ ONLY;/);
  assert.match(workflow, /action = 'wiki\.question'/);
  assert.match(workflow, /inputs->>'question' ILIKE/);
  assert.match(workflow, /LIMIT 20;/);
  assert.doesNotMatch(workflow, /workflow_dispatch:[\s\S]*command:/);
});
