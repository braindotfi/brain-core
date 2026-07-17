import { test } from "node:test";
import assert from "node:assert/strict";

import { findViolations, parseNameStatus } from "../check-migrations-append-only.mjs";

// Regression guard for commit 307ed8f, which edited comments inside the
// already-applied services/execution/migrations/0018_agents_contribution_counter.sql
// and broke the deploy workflow's whole-file hash check.

test("a modified existing migration is a violation", () => {
  const entries = parseNameStatus(
    "M\tservices/execution/migrations/0018_agents_contribution_counter.sql\n",
  );
  const violations = findViolations(entries);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /0018_agents_contribution_counter\.sql: modified/);
});

test("a deleted existing migration is a violation", () => {
  const entries = parseNameStatus("D\tservices/execution/migrations/0001_init.sql\n");
  assert.deepEqual(findViolations(entries), [
    "services/execution/migrations/0001_init.sql: deleted after being merged",
  ]);
});

test("a renamed existing migration reports the old path", () => {
  const entries = parseNameStatus(
    "R100\tservices/execution/migrations/0018_old.sql\tservices/execution/migrations/0018_new.sql\n",
  );
  const violations = findViolations(entries);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /0018_old\.sql: renamed/);
});

test("a newly added migration is fine", () => {
  const entries = parseNameStatus(
    "A\tservices/execution/migrations/0026_contribution_hold_rename.sql\n",
  );
  assert.deepEqual(findViolations(entries), []);
});

test("non-migration files are ignored regardless of status", () => {
  const entries = parseNameStatus(
    "M\tservices/execution/src/index.ts\nD\tdocs/migrations/README.md\n",
  );
  assert.deepEqual(findViolations(entries), []);
});

test("a copy of an existing migration does not flag the original", () => {
  const entries = parseNameStatus(
    "C100\tservices/execution/migrations/0018_agents_contribution_counter.sql\tservices/execution/migrations/0018_copy.sql\n",
  );
  assert.deepEqual(findViolations(entries), []);
});
