/**
 * register-internal-agents — derive and (optionally) broadcast the on-chain
 * registration payloads for Brain-shipped (internal) agents.
 *
 * Internal agents register in the SAME BrainMCPAgentRegistry as external
 * agents (principle: no parallel abstraction). This script computes the
 * deterministic capability hashes (keccak256) and the per-agent scopeHash, and
 * prints the registration payloads.
 *
 * Dry-run (default): prints JSON. Safe in CI — no chain, no secrets.
 *
 *   pnpm --filter @brain/agent-router exec tsx ../../scripts/register-internal-agents.ts
 *
 * Broadcast: BrainMCPAgentRegistry.registerAgent is PER-TENANT and requires a
 * tenant-signer EIP-712 signature, so broadcasting is a per-tenant operation
 * driven by the tenant's signer — not a one-shot deploy. The flags below mark
 * the integration point; wiring the viem call + tenant signature is a
 * follow-up (mirrors scripts/deploy-tenant-account.sh env: BASE_SEPOLIA_RPC_URL,
 * MCP_AGENT_REGISTRY_ADDRESS, TENANT_ID, TENANT_SIGNER_PRIVATE_KEY).
 */

import { buildInternalAgentRegistrations, internalAgentCatalog } from "@brain/agent-router";

function main(): void {
  const broadcast = process.argv.includes("--broadcast");
  const registrations = buildInternalAgentRegistrations(internalAgentCatalog);

  if (!broadcast) {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", registrations }, null, 2)}\n`);
    return;
  }

  // TODO(phase-1): broadcast requires a per-tenant tenant-signer EIP-712
  // signature against BrainMCPAgentRegistry.registerAgent(agentId, agentAddress,
  // tenantId, scopeHash, tenantSignature). Surface for human wiring rather than
  // guessing the signer flow.
  process.stderr.write(
    "broadcast not implemented: registerAgent is per-tenant and needs a tenant-signer signature. " +
      "Run without --broadcast for the dry-run payloads.\n",
  );
  process.exitCode = 1;
}

main();
