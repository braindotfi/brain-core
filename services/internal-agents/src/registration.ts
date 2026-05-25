/**
 * Internal-agent on-chain registration payloads.
 *
 * Internal (Brain-shipped) agents register in the SAME BrainMCPAgentRegistry
 * as external agents — distinguished only by `provenance` metadata. The
 * deployed contract keys an agent by `agentId` (bytes32) and commits a single
 * `scopeHash` (bytes32) per (agent, tenant); capability hashes fold into that
 * scope. This module derives those values deterministically so the router,
 * the catalog, and scripts/register-internal-agents.ts agree.
 *
 * NOTE: the deployed BrainMCPAgentRegistry.registerAgent requires a
 * tenant-signer EIP-712 signature and is per-tenant. Broadcasting is therefore
 * a per-tenant operation, not a one-shot deploy step — see the script.
 */

import { capabilityHash } from "@brain/shared";
import type { AgentManifest, AgentProvenance, InternalAgentDefinition } from "@brain/schemas";
import { canonicalManifest, validateManifest } from "@brain/schemas";

export interface CapabilityRegistration {
  readonly name: string;
  readonly hash: `0x${string}`;
}

export interface InternalAgentRegistration {
  readonly agent_key: string;
  readonly provenance: AgentProvenance;
  /** bytes32 agentId for BrainMCPAgentRegistry, keccak256(agent_key). */
  readonly agent_id_hash: `0x${string}`;
  /** bytes32 scopeHash committing to the agent's capability set. */
  readonly scope_hash: `0x${string}`;
  readonly capabilities: readonly CapabilityRegistration[];
}

export function buildInternalAgentRegistration(
  def: InternalAgentDefinition,
): InternalAgentRegistration {
  const capabilities = def.capabilities.map((name) => ({ name, hash: capabilityHash(name) }));
  const scopePreimage = [...def.capabilities].sort().join("|");
  return {
    agent_key: def.agent_key,
    provenance: def.provenance,
    agent_id_hash: capabilityHash(def.agent_key),
    scope_hash: capabilityHash(scopePreimage),
    capabilities,
  };
}

export function buildInternalAgentRegistrations(
  catalog: readonly InternalAgentDefinition[],
): InternalAgentRegistration[] {
  return catalog.map(buildInternalAgentRegistration);
}

// ---------------------------------------------------------------------------
// H-15 manifest scope hash + external-agent registration validation.
// ---------------------------------------------------------------------------

/** keccak256(canonical_json(manifest)) — the on-chain scope hash for an agent. */
export function computeManifestScopeHash(manifest: AgentManifest): `0x${string}` {
  return capabilityHash(canonicalManifest(manifest));
}

export interface ManifestRegistrationCheck {
  readonly ok: boolean;
  /** Structural problems with the submitted manifest (empty when ok). */
  readonly problems: readonly string[];
  /** keccak256(canonical_json(manifest)) computed from the submitted manifest. */
  readonly computedScopeHash: `0x${string}` | null;
  /** True iff the computed scope hash equals the on-chain scope hash. */
  readonly scopeHashMatches: boolean;
}

/**
 * Validate a manifest submitted at external-agent registration and cross-check
 * its canonical scope hash against the value attested on-chain in
 * BrainMCPAgentRegistry. A malformed manifest or a scope-hash mismatch must
 * reject (the route maps a failed check to `agent_manifest_invalid`).
 *
 * The on-chain scope hash is read by the caller (a BrainMCPAgentRegistry read —
 * blocked in the sandbox); pass it in so this check stays pure + testable.
 */
export function checkManifestForRegistration(
  manifest: unknown,
  onchainScopeHash: `0x${string}` | null,
): ManifestRegistrationCheck {
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    return { ok: false, problems, computedScopeHash: null, scopeHashMatches: false };
  }
  const computed = computeManifestScopeHash(manifest as AgentManifest);
  const matches =
    onchainScopeHash !== null && computed.toLowerCase() === onchainScopeHash.toLowerCase();
  return {
    ok: matches,
    problems: matches ? [] : ["manifest scope hash does not match the on-chain attestation"],
    computedScopeHash: computed,
    scopeHashMatches: matches,
  };
}
