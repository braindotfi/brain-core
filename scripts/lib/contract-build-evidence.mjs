// Extract build evidence from a Foundry artifact (contracts/out/<C>.sol/<C>.json),
// used to bind an approved audit record to the exact compiler + bytecode that was
// audited (P1 build-evidence). Pure; the caller reads the artifact JSON.

import { createHash } from "node:crypto";

/** Normalize a forge bytecode object ("0x.." or "..") to lowercase hex, no 0x. */
function normHex(s) {
  const v = String(s ?? "").toLowerCase();
  return v.startsWith("0x") ? v.slice(2) : v;
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** sha256 over the raw bytes of a forge bytecode hex object. */
export function hashBytecode(obj) {
  return sha256Hex(Buffer.from(normHex(obj), "hex"));
}

/**
 * From a parsed Foundry artifact, derive the build evidence: creation + runtime
 * bytecode sha256 and the compiler settings (solc version, optimizer, evm
 * version). Shaped to slot straight into contracts/audit-status.json.
 */
export function buildEvidenceFromArtifact(artifact) {
  const meta = artifact?.metadata ?? {};
  const settings = meta.settings ?? {};
  const optimizer = settings.optimizer ?? {};
  return {
    creation_bytecode_sha256: hashBytecode(artifact?.bytecode?.object),
    runtime_bytecode_sha256: hashBytecode(artifact?.deployedBytecode?.object),
    compiler: {
      solc_version: meta.compiler?.version ?? null,
      optimizer_enabled: typeof optimizer.enabled === "boolean" ? optimizer.enabled : null,
      optimizer_runs: typeof optimizer.runs === "number" ? optimizer.runs : null,
      evm_version: settings.evmVersion ?? null,
    },
  };
}
