// Tests for scripts/verify-audited-build.mjs. Stages a throwaway repo (contract
// sources + a fake Foundry artifact + an audit-status.json) and runs the tool
// against it via BRAIN_VERIFY_ROOT, so the lib imports still resolve from the
// real scripts/lib while the contracts/ inputs come from the fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { hashContractSources } from "../lib/hash-contract-sources.mjs";
import { buildEvidenceFromArtifact, hashBytecode } from "../lib/contract-build-evidence.mjs";

const TOOL = join(process.cwd(), "scripts/verify-audited-build.mjs");

const ARTIFACT = {
  bytecode: { object: "0x60016002600355" },
  deployedBytecode: { object: "0x6003600455" },
  metadata: {
    compiler: { version: "0.8.24+commit.e11b9ed9" },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
};

// An artifact WITH an immutable byte range (e.g. an `immutable` arbiter address):
// the on-chain runtime would carry real bytes here, so the recorded runtime hash
// must be masked over [4,6) and the immutable_references emitted.
const IMMUTABLE_ARTIFACT = {
  bytecode: { object: "0x60016002600355" },
  deployedBytecode: {
    object: "0xaabbccddeeff00112233",
    immutableReferences: { "7": [{ start: 4, length: 2 }] },
  },
  metadata: {
    compiler: { version: "0.8.24+commit.e11b9ed9" },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
};

const APPROVED_BASE = {
  contract: "BrainEscrow",
  scope_doc: "contracts/AUDIT-SCOPE.md",
  status: "approved",
  auditor: "Acme Audits",
  audited_commit: "0123456789abcdef0123456789abcdef01234567",
  report_url: "https://example.com/report.pdf",
  report_sha256: null,
  unresolved_findings: { critical: 0, high: 0, medium: 0, low: 0 },
  approved_chain_ids: [8453],
};

/** Build a staged repo; returns its root. Caller passes the audit-status doc. */
function stage(statusDoc, { mutateSource = false, artifact = ARTIFACT } = {}) {
  const root = mkdtempSync(join(tmpdir(), "verify-build-"));
  mkdirSync(join(root, "contracts/src"), { recursive: true });
  mkdirSync(join(root, "contracts/out/BrainEscrow.sol"), { recursive: true });
  writeFileSync(
    join(root, "contracts/src/BrainEscrow.sol"),
    mutateSource ? "// pragma solidity 0.8.24; // CHANGED\n" : "// pragma solidity 0.8.24;\n",
  );
  writeFileSync(join(root, "contracts/src/IBrainEscrow.sol"), "// interface\n");
  writeFileSync(
    join(root, "contracts/out/BrainEscrow.sol/BrainEscrow.json"),
    JSON.stringify(artifact),
  );
  writeFileSync(join(root, "contracts/audit-status.json"), JSON.stringify(statusDoc, null, 2));
  return root;
}

function run(root) {
  try {
    const stdout = execFileSync("node", [TOOL], {
      env: { ...process.env, BRAIN_VERIFY_ROOT: root },
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The evidence the tool will compute for the un-mutated staged repo. */
function expectedEvidence(root, artifact = ARTIFACT) {
  return {
    contract_source_tree_sha256: hashContractSources(join(root, "contracts/src")),
    ...buildEvidenceFromArtifact(artifact),
  };
}

test("pending status prints current evidence and exits 0", () => {
  const r = run(stage({ ...APPROVED_BASE, status: "pending" }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /not approved/);
  assert.match(r.stdout, /contract_source_tree_sha256/);
});

test("approved with matching evidence passes", () => {
  // Stage once to learn the evidence, then stage again with it recorded.
  const probe = stage({ ...APPROVED_BASE, status: "pending" });
  const ev = expectedEvidence(probe);
  rmSync(probe, { recursive: true, force: true });

  const r = run(stage({ ...APPROVED_BASE, ...ev }));
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /OK . current build matches/);
});

test("approved with a changed source tree fails (contract changed after audit)", () => {
  const probe = stage({ ...APPROVED_BASE, status: "pending" });
  const ev = expectedEvidence(probe);
  rmSync(probe, { recursive: true, force: true });

  // Record the un-mutated evidence but stage a MUTATED source tree.
  const r = run(stage({ ...APPROVED_BASE, ...ev }, { mutateSource: true }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /contract_source_tree_sha256/);
});

test("approved with a changed compiler setting fails", () => {
  const probe = stage({ ...APPROVED_BASE, status: "pending" });
  const ev = expectedEvidence(probe);
  rmSync(probe, { recursive: true, force: true });

  const tampered = { ...ev, compiler: { ...ev.compiler, optimizer_runs: 999 } };
  const r = run(stage({ ...APPROVED_BASE, ...tampered }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /compiler\.optimizer_runs/);
});

test("missing forge artifact fails with a clear message", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-build-"));
  mkdirSync(join(root, "contracts/src"), { recursive: true });
  writeFileSync(join(root, "contracts/src/BrainEscrow.sol"), "// x\n");
  writeFileSync(
    join(root, "contracts/audit-status.json"),
    JSON.stringify({ ...APPROVED_BASE, status: "pending" }),
  );
  const r = run(root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /forge build/);
});

test("immutable artifact: runtime hash is masked over the immutable range and refs are emitted", () => {
  const probe = stage({ ...APPROVED_BASE, status: "pending" }, { artifact: IMMUTABLE_ARTIFACT });
  const ev = expectedEvidence(probe, IMMUTABLE_ARTIFACT);
  rmSync(probe, { recursive: true, force: true });

  // The masked runtime hash MUST differ from the naive (unmasked) hash, else the
  // masking is a no-op and the on-chain comparison would false-mismatch.
  assert.notEqual(
    ev.runtime_bytecode_sha256,
    hashBytecode(IMMUTABLE_ARTIFACT.deployedBytecode.object),
  );
  assert.deepEqual(ev.immutable_references, [{ start: 4, length: 2 }]);

  // And an approved record carrying that masked evidence verifies clean.
  const r = run(stage({ ...APPROVED_BASE, ...ev }, { artifact: IMMUTABLE_ARTIFACT }));
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /OK . current build matches/);
});

test("approved with tampered immutable_references fails", () => {
  const probe = stage({ ...APPROVED_BASE, status: "pending" }, { artifact: IMMUTABLE_ARTIFACT });
  const ev = expectedEvidence(probe, IMMUTABLE_ARTIFACT);
  rmSync(probe, { recursive: true, force: true });

  const tampered = { ...ev, immutable_references: [{ start: 0, length: 2 }] };
  const r = run(stage({ ...APPROVED_BASE, ...tampered }, { artifact: IMMUTABLE_ARTIFACT }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /immutable_references/);
});
