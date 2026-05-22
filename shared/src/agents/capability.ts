/**
 * Capability hashing for the agent registry.
 *
 * A capability is identified by a stable string (e.g. "collections_followup").
 * On-chain, BrainMCPAgentRegistry and the EIP-712 ScopeAttestation key
 * capabilities by keccak256(name). This helper produces that hash so the
 * router, the internal-agent catalog, and scripts/register-internal-agents.ts
 * all derive identical bytes32 values. Mirrors the keccak usage in
 * services/policy/src/signing.ts.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

/** keccak256 of a capability identifier as a 0x-prefixed 32-byte hex string. */
export function capabilityHash(name: string): `0x${string}` {
  return `0x${bytesToHex(keccak_256(name))}`;
}
