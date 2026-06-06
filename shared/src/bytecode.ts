/**
 * Deployed-bytecode verification for the mainnet escrow boot fence (P1).
 *
 * An audit approves a specific RUNTIME bytecode. To prove the contract actually
 * deployed on-chain is that audited build, we compare the audited runtime
 * bytecode hash against the live `eth_getCode` result. But Solidity writes
 * `immutable` values (e.g. BrainEscrow's `arbiter`) into the runtime bytecode at
 * construction, so the deployed code differs from the compiler's artifact in
 * exactly those byte ranges. A naive hash would always mismatch.
 *
 * The fix: MASK the immutable byte ranges (zero them) in BOTH the artifact and
 * the deployed code before hashing. The compiler reports the ranges in
 * `deployedBytecode.immutableReferences`; we record the flattened ranges in
 * contracts/audit-status.json so the runtime fence can mask without the artifact
 * (the production image ships dist/, not contracts/out/). Library link
 * references would need the same treatment, but BrainEscrow has none.
 *
 * Pure + dependency-free (node:crypto only). The caller supplies the bytecode.
 */

import { createHash } from "node:crypto";

export interface ImmutableRef {
  /** Byte offset into the runtime bytecode. */
  start: number;
  /** Number of bytes. */
  length: number;
}

export interface BytecodeMatchResult {
  match: boolean;
  /** sha256 of the masked deployed bytecode (empty when it could not be computed). */
  actualSha256: string;
  /** Why it did not match, when applicable. */
  reason?: string;
}

function strip0x(hex: string): string {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return h.toLowerCase();
}

/**
 * Flatten a Foundry/solc `immutableReferences` map ({ astId: [{start,length}] })
 * into a plain, order-independent list of ranges.
 */
export function flattenImmutableReferences(
  refs: Record<string, ReadonlyArray<{ start: number; length: number }>> | null | undefined,
): ImmutableRef[] {
  if (refs === null || refs === undefined) return [];
  const out: ImmutableRef[] = [];
  for (const arr of Object.values(refs)) {
    for (const r of arr) out.push({ start: r.start, length: r.length });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** True when `refs` is a well-formed list of non-negative integer ranges. */
export function isValidImmutableRefs(refs: unknown): refs is ImmutableRef[] {
  return (
    Array.isArray(refs) &&
    refs.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        Number.isInteger((r as ImmutableRef).start) &&
        (r as ImmutableRef).start >= 0 &&
        Number.isInteger((r as ImmutableRef).length) &&
        (r as ImmutableRef).length >= 0,
    )
  );
}

/**
 * Zero the immutable byte ranges in a runtime bytecode hex string. Returns the
 * masked hex (no 0x). Throws if any range falls outside the bytecode (the caller
 * treats that as a non-match, since the deployed code is the wrong shape).
 */
export function maskImmutables(runtimeHex: string, refs: ReadonlyArray<ImmutableRef>): string {
  const buf = Buffer.from(strip0x(runtimeHex), "hex");
  for (const { start, length } of refs) {
    if (start < 0 || length < 0 || start + length > buf.length) {
      throw new RangeError(
        `immutable ref [${start},${start + length}) is out of range for bytecode length ${buf.length}`,
      );
    }
    buf.fill(0, start, start + length);
  }
  return buf.toString("hex");
}

/** sha256 (hex) of the masked runtime bytecode. */
export function maskedRuntimeSha256(runtimeHex: string, refs: ReadonlyArray<ImmutableRef>): string {
  return createHash("sha256").update(Buffer.from(maskImmutables(runtimeHex, refs), "hex")).digest("hex");
}

/**
 * Whether the on-chain `eth_getCode` result matches the audited runtime bytecode
 * once both are immutable-masked. Fail-closed: empty code (EOA / no contract) or
 * an out-of-range immutable ref (wrong-shape code) is a non-match.
 */
export function deployedRuntimeMatches(
  deployedHex: string,
  expectedMaskedSha256: string,
  refs: ReadonlyArray<ImmutableRef>,
): BytecodeMatchResult {
  const stripped = strip0x(deployedHex);
  if (stripped.length === 0) {
    return { match: false, actualSha256: "", reason: "no code at address (empty eth_getCode)" };
  }
  let actualSha256: string;
  try {
    actualSha256 = maskedRuntimeSha256(stripped, refs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { match: false, actualSha256: "", reason: message };
  }
  if (actualSha256 !== expectedMaskedSha256.toLowerCase()) {
    return {
      match: false,
      actualSha256,
      reason: `masked runtime bytecode hash mismatch (expected ${expectedMaskedSha256.toLowerCase()}, got ${actualSha256})`,
    };
  }
  return { match: true, actualSha256 };
}
