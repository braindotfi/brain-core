import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findViolations } from "../check-docs-drift.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "docs-drift-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(root, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("passes on reconciled prose", () => {
  const root = fixture({
    "protocol/g.md": "The gate runs 13 numbered checks + 4 hardening additions. Roots anchor hourly.",
  });
  assert.deepEqual(findViolations([join(root, "protocol")]), []);
  rmSync(root, { recursive: true, force: true });
});

test("flags hard drift (gate count, validateUserOp, anchor cadence, trace_id)", () => {
  const root = fixture({
    "protocol/g.md": [
      "The 16-step gate.",
      "Verified inside validateUserOp.",
      "Merkle roots anchor on Base every 10 minutes.",
      "The error carries a trace_id.",
    ].join("\n"),
  });
  const v = findViolations([join(root, "protocol")]);
  assert.ok(v.length >= 4, `expected >=4, got ${v.length}`);
  rmSync(root, { recursive: true, force: true });
});

test("flags forward-looking names stated as current", () => {
  const root = fixture({
    "smart-contracts/s.md": "BrainSmartAccount is an ERC-4337 account with a transparent proxy.",
  });
  assert.ok(findViolations([join(root, "smart-contracts")]).length >= 1);
  rmSync(root, { recursive: true, force: true });
});

test("allows forward-looking names when marked planned/roadmap", () => {
  const root = fixture({
    "smart-contracts/s.md": "ERC-4337 / Coinbase Smart Wallet is planned (RFC 0001), not yet shipped.",
  });
  assert.deepEqual(findViolations([join(root, "smart-contracts")]), []);
  rmSync(root, { recursive: true, force: true });
});

test("does not flag a session-key ~10-minute validity window (not anchor cadence)", () => {
  const root = fixture({
    "smart-contracts/s.md": "The per-task key has a ~10-minute validUntil.",
  });
  assert.deepEqual(findViolations([join(root, "smart-contracts")]), []);
  rmSync(root, { recursive: true, force: true });
});
