import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/check-risk-register-drift.mjs");

function runGuard(jsonRisks, md) {
  const root = mkdtempSync(join(tmpdir(), "rr-drift-"));
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "docs/risk-register.json"),
      JSON.stringify({ risks: jsonRisks }, null, 2),
    );
    writeFileSync(join(root, "docs/risk-register.md"), md);
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

function mdForOpen(id, title, status) {
  return `## Open risks\n\n### ${id}. ${title}\n\n| Field | Value |\n| --- | --- |\n| Status | **${status}** |\n`;
}

function mdForClosed(id, title) {
  return `## Open risks\n\n## Recently closed\n\n### ${id}. ${title}\n\n| Field | Value |\n| --- | --- |\n| Status | **closed** |\n`;
}

test("aligned open risk: passes", () => {
  const json = [
    { id: "R-01", title: "Demo open risk", priority: "P0", status: "open", mitigation_summary: "x" },
  ];
  const md = mdForOpen("R-01", "Demo open risk", "open");
  const r = runGuard(json, md);
  assert.equal(r.code, 0, r.stderr);
});

test("aligned closed risk with closed_at + closed_by: passes", () => {
  const json = [
    {
      id: "R-02",
      title: "Demo closed risk",
      priority: "P1",
      status: "closed",
      closed_at: "2026-05-30",
      closed_by: "batch 9 P1",
      mitigation_summary: "fix shipped",
    },
  ];
  const md = mdForClosed("R-02", "Demo closed risk");
  const r = runGuard(json, md);
  assert.equal(r.code, 0, r.stderr);
});

test("closure metadata present without status=closed: FAIL (the N-1 drift class)", () => {
  // This is the exact drift class that hit R-06/R-07 before batch 9.
  const json = [
    {
      id: "R-06",
      title: "Drift example",
      priority: "P1",
      status: "open",
      closed_at: "2026-05-30",
      closed_by: "batch 8 P2 (commit 6190ffe)",
      mitigation_summary: "x",
    },
  ];
  const md = mdForOpen("R-06", "Drift example", "open");
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /closed_at\/closed_by is set/);
  assert.match(r.stderr, /N-1 drift class/);
});

test("status=closed without closed_by: FAIL (closure stub)", () => {
  const json = [
    { id: "R-99", title: "Bad close", priority: "P2", status: "closed", closed_at: "2026-05-30" },
  ];
  const md = mdForClosed("R-99", "Bad close");
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /closed_by is missing/);
});

test("status=closed without closed_at: FAIL (closure stub)", () => {
  const json = [
    { id: "R-99", title: "Bad close", priority: "P2", status: "closed", closed_by: "batch X" },
  ];
  const md = mdForClosed("R-99", "Bad close");
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /closed_at is missing/);
});

test("mirror disagreement (json closed, md under Open risks): FAIL", () => {
  const json = [
    {
      id: "R-50",
      title: "Mirror drift",
      priority: "P2",
      status: "closed",
      closed_at: "2026-05-30",
      closed_by: "batch X",
    },
  ];
  // md heading is in the Open risks section.
  const md = `## Open risks\n\n### R-50. Mirror drift\n\n| Field | Value |\n| --- | --- |\n| Status | **closed** |\n`;
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  // The heading appears under Open risks but body says closed → md:R-50 should be reported.
  assert.match(r.stderr, /R-50/);
});

test("md heading present, json missing: FAIL", () => {
  const json = [];
  const md = mdForOpen("R-77", "Only in md", "open");
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /R-77.* missing from risk-register\.json/);
});

test("json risk present, md missing: FAIL", () => {
  const json = [{ id: "R-88", title: "Only in json", priority: "P2", status: "open" }];
  const md = "## Open risks\n\n";
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /R-88.* missing from risk-register\.md/);
});

test("invalid status value: FAIL", () => {
  const json = [{ id: "R-1", title: "x", priority: "P0", status: "in_progress" }];
  const md = mdForOpen("R-1", "x", "open");
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /status="in_progress" is invalid/);
});

test("invalid priority: FAIL", () => {
  const json = [{ id: "R-1", title: "x", priority: "URGENT", status: "open" }];
  const md = mdForOpen("R-1", "x", "open");
  const r = runGuard(json, md);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /priority="URGENT" is invalid/);
});

test("the real repo's register is currently OK (sanity guard)", () => {
  const stdout = execFileSync("node", [SCRIPT], { encoding: "utf8" });
  assert.match(stdout, /risk-register-drift guard: OK/);
});
