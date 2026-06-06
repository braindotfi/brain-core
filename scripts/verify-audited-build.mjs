#!/usr/bin/env node
/**
 * verify-audited-build: bind the committed audit record to the REAL build.
 *
 * P1 (external review): an approved audit-status.json must name the exact
 * source tree, compiler, and creation/runtime bytecode that were audited. This
 * tool recomputes that evidence from the working tree + the Foundry artifact and
 * compares it to the committed record, so a contract or toolchain change after
 * the audited commit cannot ride an older approval.
 *
 * Run in CI AFTER `forge build` (the contracts job):
 *   - status pending / in_progress: PRINT the current evidence (so the auditor
 *     can populate audit-status.json from the final report) and exit 0.
 *   - status approved: ASSERT the current source-tree hash + creation/runtime
 *     bytecode + compiler settings match the committed values; exit 1 on drift.
 *
 * Scope: BrainEscrow (the only funds-custodying contract; the mainnet escrow
 * boot fence is what consumes the approval). The deployed on-chain bytecode
 * check (eth_getCode at API boot) is a separate, follow-up runtime fence.
 *
 * BRAIN_VERIFY_ROOT overrides the repo root (used by tests); defaults to cwd.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hashContractSources } from "./lib/hash-contract-sources.mjs";
import { buildEvidenceFromArtifact } from "./lib/contract-build-evidence.mjs";

const ROOT = process.env.BRAIN_VERIFY_ROOT ?? process.cwd();
const STATUS = join(ROOT, "contracts/audit-status.json");
const SRC = join(ROOT, "contracts/src");
const ARTIFACT = join(ROOT, "contracts/out/BrainEscrow.sol/BrainEscrow.json");

const COMPILER_KEYS = ["solc_version", "optimizer_enabled", "optimizer_runs", "evm_version"];

function currentEvidence() {
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  } catch {
    console.error(
      `verify-audited-build: ${ARTIFACT} not found. Run \`forge build\` before this check.`,
    );
    process.exit(1);
  }
  return {
    contract_source_tree_sha256: hashContractSources(SRC),
    ...buildEvidenceFromArtifact(artifact),
  };
}

function main() {
  let doc;
  try {
    doc = JSON.parse(readFileSync(STATUS, "utf8"));
  } catch (err) {
    console.error(`verify-audited-build: cannot read ${STATUS}: ${err.message}`);
    process.exit(1);
  }

  const current = currentEvidence();

  if (doc.status !== "approved") {
    console.log(
      `verify-audited-build: status is "${doc.status}" (not approved) — current build evidence:`,
    );
    console.log(JSON.stringify(current, null, 2));
    console.log(
      "Record these values into contracts/audit-status.json from the auditor's final report when the audit completes.",
    );
    return;
  }

  const mismatches = [];
  if (doc.contract_source_tree_sha256 !== current.contract_source_tree_sha256) {
    mismatches.push(
      `contract_source_tree_sha256: committed ${doc.contract_source_tree_sha256} != current ${current.contract_source_tree_sha256}`,
    );
  }
  if (doc.creation_bytecode_sha256 !== current.creation_bytecode_sha256) {
    mismatches.push(
      `creation_bytecode_sha256: committed ${doc.creation_bytecode_sha256} != current ${current.creation_bytecode_sha256}`,
    );
  }
  if (doc.runtime_bytecode_sha256 !== current.runtime_bytecode_sha256) {
    mismatches.push(
      `runtime_bytecode_sha256: committed ${doc.runtime_bytecode_sha256} != current ${current.runtime_bytecode_sha256}`,
    );
  }
  // immutable_references must match exactly: the runtime hash above is masked
  // over precisely these byte ranges, and the boot fence masks the on-chain code
  // over the committed ranges. If they drift, the masked hashes are comparing
  // different regions and the on-chain verification is meaningless.
  if (JSON.stringify(doc.immutable_references) !== JSON.stringify(current.immutable_references)) {
    mismatches.push(
      `immutable_references: committed ${JSON.stringify(doc.immutable_references)} != current ${JSON.stringify(current.immutable_references)}`,
    );
  }
  const committedCompiler = doc.compiler ?? {};
  for (const k of COMPILER_KEYS) {
    if (JSON.stringify(committedCompiler[k]) !== JSON.stringify(current.compiler[k])) {
      mismatches.push(
        `compiler.${k}: committed ${JSON.stringify(committedCompiler[k])} != current ${JSON.stringify(current.compiler[k])}`,
      );
    }
  }

  if (mismatches.length > 0) {
    console.error(
      "verify-audited-build: FAIL — the current build does not match the approved audit record:",
    );
    for (const m of mismatches) console.error(`  - ${m}`);
    console.error(
      "\nThe approved audit covers a specific source tree + compiler + bytecode. A mismatch means the\n" +
        "contract or toolchain changed after the audited commit, so the deployed code is NOT what was\n" +
        "audited. Re-audit (update audit-status.json from a new report) or revert the change.",
    );
    process.exit(1);
  }

  console.log("verify-audited-build: OK — current build matches the approved audit record.");
}

main();
