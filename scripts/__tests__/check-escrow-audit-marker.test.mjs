import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/check-escrow-audit-marker.mjs");

function runGuard(fixtureFiles) {
  const root = mkdtempSync(join(tmpdir(), "escrow-audit-"));
  try {
    for (const [relPath, content] of Object.entries(fixtureFiles)) {
      const full = join(root, relPath);
      mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      writeFileSync(full, content);
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

const ADDR = "0x" + "ab".repeat(20);

test("empty repo: OK", () => {
  const r = runGuard({});
  assert.equal(r.code, 0);
  assert.match(r.stdout, /OK/);
});

test("Sepolia (84532) with escrow address but no audit flag: silent", () => {
  const r = runGuard({
    ".env": `BRAIN_BASE_CHAIN_ID=84532\nBRAIN_ESCROW_ADDRESS=${ADDR}\n`,
  });
  assert.equal(r.code, 0);
});

test("local Foundry (31337) with escrow address but no audit flag: silent", () => {
  const r = runGuard({
    ".env": `BRAIN_BASE_CHAIN_ID=31337\nBRAIN_ESCROW_ADDRESS=${ADDR}\n`,
  });
  assert.equal(r.code, 0);
});

test("mainnet (8453) with no escrow address: silent", () => {
  const r = runGuard({
    ".env": `BRAIN_BASE_CHAIN_ID=8453\n`,
  });
  assert.equal(r.code, 0);
});

test("mainnet + escrow address + audit_approved=true: silent", () => {
  const r = runGuard({
    ".env":
      `BRAIN_BASE_CHAIN_ID=8453\n` +
      `BRAIN_ESCROW_ADDRESS=${ADDR}\n` +
      `BRAIN_ESCROW_AUDIT_APPROVED=true\n`,
  });
  assert.equal(r.code, 0, r.stderr);
});

test("mainnet + escrow address + audit_approved missing: FAIL", () => {
  const r = runGuard({
    ".env": `BRAIN_BASE_CHAIN_ID=8453\nBRAIN_ESCROW_ADDRESS=${ADDR}\n`,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BRAIN_BASE_CHAIN_ID=8453.*BRAIN_ESCROW_ADDRESS=0xab/);
  assert.match(r.stderr, /BRAIN_ESCROW_AUDIT_APPROVED=\(unset\)/);
});

test("other non-testnet chain + escrow address + audit_approved missing: FAIL", () => {
  for (const chainId of ["1", "10", "137", "42161"]) {
    const r = runGuard({
      ".env": `BRAIN_BASE_CHAIN_ID=${chainId}\nBRAIN_ESCROW_ADDRESS=${ADDR}\n`,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`BRAIN_BASE_CHAIN_ID=${chainId}`));
  }
});

test("mainnet + escrow address + audit_approved=false: FAIL", () => {
  const r = runGuard({
    ".env":
      `BRAIN_BASE_CHAIN_ID=8453\n` +
      `BRAIN_ESCROW_ADDRESS=${ADDR}\n` +
      `BRAIN_ESCROW_AUDIT_APPROVED=false\n`,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /BRAIN_ESCROW_AUDIT_APPROVED=false/);
});

test("split across files (mainnet in one, escrow addr in another): silent", () => {
  // The guard intentionally requires all three signals in the SAME file.
  // Splitting them across files would defeat the boot fence at runtime too
  // (env merging across deploy modules), so this guard mirrors that posture.
  const r = runGuard({
    "infra/main.tf": `BRAIN_BASE_CHAIN_ID = "8453"\n`,
    "infra/escrow.tf": `BRAIN_ESCROW_ADDRESS = "${ADDR}"\n`,
  });
  assert.equal(r.code, 0);
});

test("Terraform .tf assignment style detected", () => {
  const r = runGuard({
    "infra/prod.tf": `BRAIN_BASE_CHAIN_ID = "8453"\n` + `BRAIN_ESCROW_ADDRESS = "${ADDR}"\n`,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /infra\/prod\.tf/);
});

test("YAML top-level keys detected", () => {
  const r = runGuard({
    "deploy/values.yaml": `BRAIN_BASE_CHAIN_ID: 8453\n` + `BRAIN_ESCROW_ADDRESS: "${ADDR}"\n`,
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /deploy\/values\.yaml/);
});

test("indented YAML key (nested) is NOT detected (avoids false positives)", () => {
  // A nested key under a `spec:` parent isn't a top-level assignment;
  // parsing as one would yield false positives in helm charts and k8s
  // manifests where unrelated structures live in the same file.
  const r = runGuard({
    "deploy/values.yaml": `env:\n  BRAIN_BASE_CHAIN_ID: 8453\n  BRAIN_ESCROW_ADDRESS: "${ADDR}"\n`,
  });
  assert.equal(r.code, 0);
});

test("export-prefixed shell assignment detected", () => {
  const r = runGuard({
    "deploy/run.sh": `export BRAIN_BASE_CHAIN_ID=8453\n` + `export BRAIN_ESCROW_ADDRESS=${ADDR}\n`,
  });
  assert.equal(r.code, 1);
});

test("mainnet + escrow address + AUDIT_RECEIPT set: silent (preferred path)", () => {
  const r = runGuard({
    ".env":
      `BRAIN_BASE_CHAIN_ID=8453\n` +
      `BRAIN_ESCROW_ADDRESS=${ADDR}\n` +
      `BRAIN_ESCROW_AUDIT_RECEIPT="https://audits.brain.fi/escrow.pdf#commit=abc"\n`,
  });
  assert.equal(r.code, 0, r.stderr);
});

test("mainnet + escrow address + empty AUDIT_RECEIPT: FAIL", () => {
  const r = runGuard({
    ".env":
      `BRAIN_BASE_CHAIN_ID=8453\n` +
      `BRAIN_ESCROW_ADDRESS=${ADDR}\n` +
      `BRAIN_ESCROW_AUDIT_RECEIPT=""\n`,
  });
  assert.equal(r.code, 1);
});

test("AUDIT_RECEIPT takes precedence over AUDIT_APPROVED=false", () => {
  const r = runGuard({
    ".env":
      `BRAIN_BASE_CHAIN_ID=8453\n` +
      `BRAIN_ESCROW_ADDRESS=${ADDR}\n` +
      `BRAIN_ESCROW_AUDIT_APPROVED=false\n` +
      `BRAIN_ESCROW_AUDIT_RECEIPT="https://audits.brain.fi/escrow.pdf"\n`,
  });
  assert.equal(r.code, 0);
});

test("the real repo is currently OK (sanity guard)", () => {
  const stdout = execFileSync("node", [SCRIPT], { encoding: "utf8" });
  assert.match(stdout, /escrow-audit-marker guard: OK/);
});
