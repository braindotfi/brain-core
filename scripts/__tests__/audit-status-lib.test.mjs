// Tests for the .mjs port of the canonical audit-status validator
// (scripts/lib/audit-status.mjs). Drives the SHARED parity corpus
// (scripts/lib/audit-status.fixtures.json) that the TS port's test
// (shared/src/audit-status.test.ts) also consumes, so the two ports cannot
// diverge: any drift fails one side against the common fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseAuditStatus,
  checkIntegrity,
  evaluateApproval,
  isChainApproved,
} from "../lib/audit-status.mjs";

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("../lib/audit-status.fixtures.json", import.meta.url)), "utf8"),
);

test("parity corpus: integrity + approval verdicts match the shared fixtures", () => {
  for (const c of corpus.cases) {
    const integrity = checkIntegrity(c.doc);
    assert.equal(integrity.ok, c.integrityOk, `${c.name}: integrityOk`);

    const approval = evaluateApproval(c.doc);
    assert.equal(approval.approved, c.approved, `${c.name}: approved`);

    if (c.approved === false) {
      assert.ok(approval.reasons.length > 0, `${c.name}: a rejection must carry at least one reason`);
    }
    if (typeof c.reasonSubstr === "string") {
      assert.ok(
        approval.reasons.some((r) => r.includes(c.reasonSubstr)),
        `${c.name}: expected a reason containing ${JSON.stringify(c.reasonSubstr)}, got ${JSON.stringify(approval.reasons)}`,
      );
    }
  }
});

test("parity corpus: isChainApproved matches the shared chain-approval fixtures", () => {
  for (const c of corpus.chainApprovalCases) {
    assert.equal(
      isChainApproved({ approved_chain_ids: c.approved_chain_ids }, c.chainId),
      c.expected,
      c.name,
    );
  }
  // Fail-closed on a non-object document.
  assert.equal(isChainApproved(null, 8453), false);
});

test("evaluateApproval is fail-closed on a non-object document", () => {
  for (const bad of [null, undefined, 42, "approved", []]) {
    const { approved, reasons } = evaluateApproval(bad);
    assert.equal(approved, false, `non-object ${JSON.stringify(bad)} must not be approved`);
    assert.ok(reasons.length > 0);
  }
});

test("parseAuditStatus rejects malformed JSON and accepts a valid object", () => {
  const bad = parseAuditStatus("{ not json");
  assert.equal(bad.ok, false);
  assert.equal(bad.doc, null);
  assert.ok(typeof bad.error === "string" && bad.error.length > 0);

  const good = parseAuditStatus('{"status":"pending"}');
  assert.equal(good.ok, true);
  assert.deepEqual(good.doc, { status: "pending" });
  assert.equal(good.error, null);

  // A pre-parsed object is passed through unchanged.
  const obj = parseAuditStatus({ status: "approved" });
  assert.equal(obj.ok, true);
  assert.deepEqual(obj.doc, { status: "approved" });
});

test("checkIntegrity passes the real committed contracts/audit-status.json", () => {
  const real = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../contracts/audit-status.json", import.meta.url)),
      "utf8",
    ),
  );
  const { ok, reasons } = checkIntegrity(real);
  assert.equal(ok, true, `committed audit-status.json failed integrity: ${JSON.stringify(reasons)}`);
});
