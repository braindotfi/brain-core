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

/**
 * The on-chain `scopeHash` an agent commits to in BrainMCPAgentRegistry, derived
 * from its scope set. Preimage is the scopes sorted lexicographically and joined
 * with "|", then keccak256 — identical to the capability-set derivation in
 * services/internal-agents/src/registration.ts (sorted-join → capabilityHash).
 *
 * This is the single source of truth for the value that must agree across three
 * places: the `agents.scope_hash` DB column (written by the demo seed), the
 * registration broadcast (scripts/ops/register-prod-agent.ts), and the on-chain
 * record the MCP auth path reads back (services/mcp/src/auth.ts). Anything that
 * needs the scope hash must call this — never re-implement the preimage.
 */
export function computeAgentScopeHash(scopes: readonly string[]): `0x${string}` {
  const preimage = [...scopes].sort().join("|");
  return capabilityHash(preimage);
}
