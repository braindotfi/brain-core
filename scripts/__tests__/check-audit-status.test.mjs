import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/check-audit-status.mjs");

/** Run the guard with a contracts/audit-status.json fixture (object or raw string). */
function runGuard(fixture) {
  const root = mkdtempSync(join(tmpdir(), "audit-status-"));
  try {
    if (fixture !== undefined) {
      mkdirSync(join(root, "contracts"), { recursive: true });
      const body = typeof fixture === "string" ? fixture : JSON.stringify(fixture, null, 2);
      writeFileSync(join(root, "contracts/audit-status.json"), body);
    }
    try {
      const stdout = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      return {
        code: err.status ?? 1,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? "",
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PENDING = {
  contract: "BrainEscrow",
  scope_doc: "contracts/AUDIT-SCOPE.md",
  status: "pending",
  auditor: null,
  audited_commit: null,
  report_url: null,
  report_sha256: null,
  unresolved_findings: { critical: null, high: null, medium: null, low: null },
};

const APPROVED = {
  contract: "BrainEscrow",
  scope_doc: "contracts/AUDIT-SCOPE.md",
  status: "approved",
  auditor: "Spearbit",
  audited_commit: "a".repeat(40),
  report_url: "https://reports.example/brain-escrow.pdf",
  report_sha256: null,
  unresolved_findings: { critical: 0, high: 0, medium: 2, low: 5 },
  // Build-evidence binding (required for approval).
  compiler: {
    solc_version: "0.8.24+commit.e11b9ed9",
    optimizer_enabled: true,
    optimizer_runs: 200,
    evm_version: "cancun",
  },
  contract_source_tree_sha256: "a".repeat(64),
  creation_bytecode_sha256: "b".repeat(64),
  runtime_bytecode_sha256: "c".repeat(64),
  approved_chain_ids: [8453],
};

test("valid pending: OK", () => {
  const r = runGuard(PENDING);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK.*status=pending/);
});

test("valid in_progress: OK", () => {
  const r = runGuard({ ...PENDING, status: "in_progress" });
  assert.equal(r.code, 0, r.stderr);
});

test("fully-evidenced approved: OK", () => {
  const r = runGuard(APPROVED);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /status=approved/);
});

test("approved without an auditor: FAIL", () => {
  const r = runGuard({ ...APPROVED, auditor: null });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires a non-empty auditor/);
});

test("approved with a non-40-hex commit: FAIL", () => {
  const r = runGuard({ ...APPROVED, audited_commit: "deadbeef" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /40-hex git SHA/);
});

test("approved with no report reference: FAIL", () => {
  const r = runGuard({ ...APPROVED, report_url: null, report_sha256: null });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /report_url or a report_sha256/);
});

test("approved with an open critical finding: FAIL", () => {
  const r = runGuard({
    ...APPROVED,
    unresolved_findings: { critical: 1, high: 0, medium: 0, low: 0 },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /critical === 0/);
});

test("approved with an open high finding: FAIL", () => {
  const r = runGuard({
    ...APPROVED,
    unresolved_findings: { critical: 0, high: 3, medium: 0, low: 0 },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /high === 0/);
});

test("invalid status value: FAIL", () => {
  const r = runGuard({ ...PENDING, status: "done" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /status must be one of/);
});

test("negative unresolved-finding count: FAIL", () => {
  const r = runGuard({
    ...PENDING,
    unresolved_findings: { critical: -1, high: 0, medium: 0, low: 0 },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /non-negative integer/);
});

test("missing file: FAIL", () => {
  const r = runGuard(undefined);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing/);
});

test("malformed JSON: FAIL", () => {
  const r = runGuard("{ not json");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
});
