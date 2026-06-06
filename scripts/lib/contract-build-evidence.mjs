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
 * Flatten a solc immutableReferences map ({astId:[{start,length}]}) into a sorted
 * list of {start,length}. These are the byte offsets where Solidity writes
 * immutable values into the deployed code at construction, so they differ
 * on-chain from the artifact's deployedBytecode (which has zeros there). The
 * mainnet escrow fence masks them before comparing.
 */
export function flattenImmutableReferences(refs) {
  if (refs === null || refs === undefined) return [];
  const out = [];
  for (const arr of Object.values(refs)) {
    for (const r of arr) out.push({ start: r.start, length: r.length });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Zero the immutable byte ranges in a runtime bytecode hex; returns a Buffer. */
function maskImmutables(runtimeHex, refs) {
  const buf = Buffer.from(normHex(runtimeHex), "hex");
  for (const { start, length } of refs) buf.fill(0, start, start + length);
  return buf;
}

/**
 * From a parsed Foundry artifact, derive the build evidence: creation + runtime
 * bytecode sha256, the immutable byte ranges, and the compiler settings (solc
 * version, optimizer, evm version). Shaped to slot straight into
 * contracts/audit-status.json.
 *
 * The runtime hash is IMMUTABLE-MASKED so it matches the on-chain eth_getCode
 * result (Solidity writes immutables into the deployed code at construction).
 * The mainnet escrow boot fence (assertDeployedEscrowBytecode) compares
 * masked-vs-masked, so emitting the masked hash here keeps the committed record
 * consistent with what the fence computes from the live chain.
 */
export function buildEvidenceFromArtifact(artifact) {
  const meta = artifact?.metadata ?? {};
  const settings = meta.settings ?? {};
  const optimizer = settings.optimizer ?? {};
  const immutableReferences = flattenImmutableReferences(
    artifact?.deployedBytecode?.immutableReferences,
  );
  const runtimeMasked = maskImmutables(artifact?.deployedBytecode?.object, immutableReferences);
  return {
    creation_bytecode_sha256: hashBytecode(artifact?.bytecode?.object),
    runtime_bytecode_sha256: sha256Hex(runtimeMasked),
    immutable_references: immutableReferences,
    compiler: {
      solc_version: meta.compiler?.version ?? null,
      optimizer_enabled: typeof optimizer.enabled === "boolean" ? optimizer.enabled : null,
      optimizer_runs: typeof optimizer.runs === "number" ? optimizer.runs : null,
      evm_version: settings.evmVersion ?? null,
    },
  };
}
