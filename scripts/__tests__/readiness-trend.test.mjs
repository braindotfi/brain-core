import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TREND_SCRIPT = join(process.cwd(), "scripts/readiness-trend.mjs");
const SNAPSHOT_SCRIPT = join(process.cwd(), "scripts/readiness-snapshot.mjs");
const AGGREGATOR = join(process.cwd(), "scripts/production-readiness.mjs");
const AUDIT_STATUS_LIB = join(process.cwd(), "scripts/lib/audit-status.mjs");

function fakeSnapshot(overrides = {}) {
  const aggregator = {
    node_env: "test",
    overall_status: overrides.overall ?? "yellow",
    sections: {
      rails: overrides.rails ?? [],
      fences: overrides.fences ?? [],
      ci_guards: overrides.ci_guards ?? [],
      deferred: overrides.deferred ?? [],
      risks: overrides.risks ?? [],
    },
  };
  return {
    captured_at_tag: overrides.tag ?? "test",
    aggregator,
  };
}

function tempHistoryRoot(snapshots) {
  // Build a temp repo root containing only docs/readiness-history/ and the
  // two scripts that load relative to ROOT (= process.cwd()).
  const root = mkdtempSync(join(tmpdir(), "readiness-trend-"));
  mkdirSync(join(root, "docs/readiness-history"), { recursive: true });
  for (const [name, body] of Object.entries(snapshots)) {
    writeFileSync(
      join(root, "docs/readiness-history", `${name}.json`),
      JSON.stringify(body, null, 2),
    );
  }
  return root;
}

function runTrend(root) {
  return execFileSync("node", [TREND_SCRIPT], { cwd: root, encoding: "utf8" });
}

test("empty history dir prints helpful message", () => {
  const root = mkdtempSync(join(tmpdir(), "readiness-trend-empty-"));
  try {
    mkdirSync(join(root, "docs/readiness-history"), { recursive: true });
    const out = runTrend(root);
    assert.match(out, /no snapshots/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trend table includes one row per snapshot, alphabetically sorted", () => {
  const root = tempHistoryRoot({
    "v0.3.0-rc.1": fakeSnapshot({ overall: "yellow", tag: "v0.3.0-rc.1" }),
    "v0.3.0-rc.2": fakeSnapshot({ overall: "red", tag: "v0.3.0-rc.2" }),
  });
  try {
    const out = runTrend(root);
    const tagLines = out.split("\n").filter((l) => /v0\.3\.0-rc\.\d/.test(l));
    assert.equal(tagLines.length, 2);
    // sorted alphabetically
    assert.ok(tagLines[0].indexOf("v0.3.0-rc.1") >= 0);
    assert.ok(tagLines[1].indexOf("v0.3.0-rc.2") >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("open P0 counts come from risks section [P0 open] notes", () => {
  const root = tempHistoryRoot({
    "a-baseline": fakeSnapshot({
      risks: [
        { name: "R-01 foo", status: "red", note: "[P0 open] mitigation summary" },
        { name: "R-02 bar", status: "yellow", note: "[P0 mitigating] mitigation summary" },
        { name: "R-03 baz", status: "yellow", note: "[P1 open] mitigation summary" },
      ],
    }),
  });
  try {
    const out = runTrend(root);
    const row = out.split("\n").find((l) => /a-baseline/.test(l));
    // Last two columns (P0 P1) should report 1 P0 open, 1 P1 open.
    assert.match(row, /1\s+1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ΔP0 column shows change in open P0 count between adjacent snapshots", () => {
  const root = tempHistoryRoot({
    "a-1-p0": fakeSnapshot({
      risks: [{ name: "R-01", status: "red", note: "[P0 open] x" }],
    }),
    "b-0-p0": fakeSnapshot({
      risks: [],
    }),
  });
  try {
    const out = runTrend(root);
    const lines = out.split("\n").filter((l) => /^\s+[ab]-/.test(l));
    // First snapshot: ΔP0 is "—" (no prior).
    assert.match(lines[0], /—/);
    // Second snapshot: open P0 went 1 → 0, ΔP0 should be "-1".
    assert.match(lines[1], /-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot script requires a tag arg and refuses to overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "readiness-snapshot-"));
  try {
    // Provide the aggregator + a minimal repo skeleton the aggregator reads.
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "services/api/src/composition"), { recursive: true });
    mkdirSync(join(root, "contracts"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    cpSync(AGGREGATOR, join(root, "scripts/production-readiness.mjs"));
    cpSync(SNAPSHOT_SCRIPT, join(root, "scripts/readiness-snapshot.mjs"));
    // production-readiness.mjs imports ./lib/audit-status.mjs (the canonical
    // audit-status validator); stage it alongside so the import resolves.
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    cpSync(AUDIT_STATUS_LIB, join(root, "scripts/lib/audit-status.mjs"));
    // Stub the files the aggregator reads.
    writeFileSync(
      join(root, "services/api/src/composition/rail-catalog.ts"),
      'export const RAIL_CATALOG = [{ name: "bank_ach", description: "x", productionAllowed: true, requiredEnv: ["PLAID_CLIENT_ID"], evmChain: false, auditRequired: false }];',
    );
    writeFileSync(join(root, "contracts/AUDIT-SCOPE.md"), "noop");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          "check-scope-vocab": "x",
          "check-gate-bypass": "x",
          "check-payment-intent-loaders": "x",
          "check-no-em-dashes": "x",
          "check-wiki-no-ledger-write": "x",
          "check-policy-no-wiki-read": "x",
          "check-no-onchain-pii": "x",
          "check-docs-drift": "x",
          "check-rails-catalog-drift": "x",
          "check-escrow-audit-marker": "x",
        },
        // No lint wiring in fixture; the aggregator's CI guards section will
        // be yellow for "defined but NOT wired into lint". That's fine for
        // this test — we're verifying snapshot capture, not aggregator
        // health.
      }),
    );
    writeFileSync(
      join(root, "docs/risk-register.json"),
      JSON.stringify({ schema_version: "v1", risks: [] }),
    );

    // No tag.
    let stderr = "";
    try {
      execFileSync("node", [join(root, "scripts/readiness-snapshot.mjs")], {
        cwd: root,
        encoding: "utf8",
      });
    } catch (err) {
      stderr = err.stderr?.toString() ?? "";
    }
    assert.match(stderr, /usage: readiness-snapshot/);

    // With a tag → writes a snapshot.
    execFileSync(
      "node",
      [join(root, "scripts/readiness-snapshot.mjs"), "first-tag"],
      { cwd: root, encoding: "utf8" },
    );
    // Re-run with same tag → refuses.
    let secondErr = "";
    try {
      execFileSync(
        "node",
        [join(root, "scripts/readiness-snapshot.mjs"), "first-tag"],
        { cwd: root, encoding: "utf8" },
      );
    } catch (err) {
      secondErr = err.stderr?.toString() ?? "";
    }
    assert.match(secondErr, /refusing to overwrite/);

    // Invalid tag chars rejected.
    let invalidErr = "";
    try {
      execFileSync(
        "node",
        [join(root, "scripts/readiness-snapshot.mjs"), "../escape"],
        { cwd: root, encoding: "utf8" },
      );
    } catch (err) {
      invalidErr = err.stderr?.toString() ?? "";
    }
    assert.match(invalidErr, /must be \[a-zA-Z0-9/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
