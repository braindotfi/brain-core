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
import type { AgentProvenance, InternalAgentDefinition } from "@brain/schemas";

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
