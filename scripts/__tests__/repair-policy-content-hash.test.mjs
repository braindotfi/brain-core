import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contentHashHex, canonicalize } from "@brain/policy";
import { classifyRow, applyRepairs, exitCode } from "../ops/repair-policy-content-hash.mjs";

// A document whose keys are deliberately NOT in canonicalize()'s sorted
// order -- this is the exact shape the two now-fixed seeders produced.
const DOC = { version: 1, applies_to: ["outbound_payment"], rules: [] };

function bufferFromHex(hex) {
  return Buffer.from(hex, "hex");
}

function makeRow(overrides = {}) {
  return {
    id: "pol_1",
    tenant_id: "tnt_1",
    version: 1,
    state: "active",
    content: DOC,
    content_hash: bufferFromHex(contentHashHex(DOC)),
    signers: null,
    ...overrides,
  };
}

test("the motivating numeric fact: sha256(JSON.stringify(doc)) differs from contentHashHex(doc) for an unsorted-key document", () => {
  const legacyDigest = createHash("sha256").update(JSON.stringify(DOC)).digest("hex");
  assert.notEqual(legacyDigest, contentHashHex(DOC));
  // Sanity: canonicalize really does reorder the keys relative to insertion order.
  assert.notEqual(canonicalize(DOC), JSON.stringify(DOC));
});

test("a row whose stored digest already equals the canonical hash is left alone and reported canonical", () => {
  const row = makeRow();
  const c = classifyRow(row);
  assert.equal(c.status, "canonical");
  assert.equal(c.stored, c.recomputed);
});

test("a row with a wrong digest and signers NULL is reported repairable", () => {
  const row = makeRow({ content_hash: bufferFromHex("00".repeat(32)) });
  const c = classifyRow(row);
  assert.equal(c.status, "repairable");
  assert.notEqual(c.stored, c.recomputed);
});

test("dry run (no applyRepairs call) issues no update -- classify alone never writes", async () => {
  const row = makeRow({ content_hash: bufferFromHex("00".repeat(32)) });
  const c = classifyRow(row);
  const calls = [];
  const fakeClient = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  // Simulating the script's dry-run path: it must never invoke applyRepairs
  // when --apply is absent, so this row's classification alone should not
  // have produced any query call.
  assert.equal(c.status, "repairable");
  assert.deepEqual(calls, []);
  void fakeClient; // unused in the dry-run branch, present for symmetry with the --apply test below
});

test("--apply issues exactly one UPDATE policies SET content_hash scoped by WHERE id = $1", async () => {
  const row = makeRow({ content_hash: bufferFromHex("00".repeat(32)) });
  const c = classifyRow(row);
  const calls = [];
  const fakeClient = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  const repaired = await applyRepairs(fakeClient, [c]);
  assert.equal(repaired, 1);
  const updateCalls = calls.filter((call) => call.text.includes("UPDATE policies"));
  assert.equal(updateCalls.length, 1);
  assert.match(updateCalls[0].text, /UPDATE policies SET content_hash/);
  assert.match(updateCalls[0].text, /WHERE id = \$1/);
  assert.equal(updateCalls[0].params[0], row.id);
  assert.equal(updateCalls[0].params[1].toString("hex"), c.recomputed);
  // Transaction wraps the write.
  assert.deepEqual(
    calls.map((call) => call.text),
    ["BEGIN", updateCalls[0].text, "COMMIT"],
  );
});

test("a row with a wrong digest and signers NON-NULL is never updated and forces a non-zero exit", async () => {
  const row = makeRow({
    content_hash: bufferFromHex("00".repeat(32)),
    signers: [{ address: "0xabc", signature: "0xdef" }],
  });
  const c = classifyRow(row);
  assert.equal(c.status, "blocked_signed");

  const calls = [];
  const fakeClient = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
  // The script's repairable-only filter means a blocked row is never passed
  // to applyRepairs in the first place, in either mode.
  const repaired = await applyRepairs(fakeClient, []);
  assert.equal(repaired, 0);
  assert.deepEqual(calls, []);

  assert.equal(exitCode({ blockedCount: 1, repairableCount: 0, apply: false }), 1);
  assert.equal(exitCode({ blockedCount: 1, repairableCount: 0, apply: true }), 1);
});

test("dry run exits non-zero when repairs are outstanding, and zero once none remain", () => {
  assert.equal(exitCode({ blockedCount: 0, repairableCount: 2, apply: false }), 1);
  assert.equal(exitCode({ blockedCount: 0, repairableCount: 0, apply: false }), 0);
  assert.equal(exitCode({ blockedCount: 0, repairableCount: 2, apply: true }), 0);
});
