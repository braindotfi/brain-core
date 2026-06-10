import test from "node:test";
import assert from "node:assert/strict";
import { pascal, scaffold } from "../scaffold-connector.mjs";

// The full file-generation path is exercised as a smoke run against the real
// repo in development (scaffold + lint + typecheck + test, then revert); these
// tests pin the input validation that protects the repo from a bad run.

test("pascal converts snake_case provider names", () => {
  assert.equal(pascal("merge_accounting"), "MergeAccounting");
  assert.equal(pascal("finch"), "Finch");
});

test("rejects non-snake_case connector names before touching any file", () => {
  assert.throws(() => scaffold("Merge-Accounting"), /snake_case/);
  assert.throws(() => scaffold("9starts_with_digit"), /snake_case/);
});

test("rejects an existing source type before touching any file", () => {
  assert.throws(() => scaffold("plaid"), /already exists/);
  assert.throws(() => scaffold("other"), /already exists/);
});
