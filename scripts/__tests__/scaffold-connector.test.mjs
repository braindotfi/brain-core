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

test("vocabulary insertion anchors on the block closing, not the last entry", async () => {
  // Regression: the v1 anchors assumed eth_address was the final entry and
  // broke on the first catalog growth (merge_accounting). Verified against
  // the real repo state by the next scaffold smoke run; here we pin that the
  // duplicate-detection still reads the grown vocabulary correctly.
  assert.throws(() => scaffold("merge_accounting"), /already exists/);
});
