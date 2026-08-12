/**
 * Boot fence for the agent on-chain registration relayer (RFC 0002 Phase C,
 * increments 3-4).
 *
 * BRAIN_AGENT_RELAYER_MODE="off" (the default) needs nothing: AgentService
 * gets UnconfiguredRegistrationRelayer and POST /agents keeps returning
 * agent_rail_unavailable for both attested modes, unchanged from before
 * either relayer existed.
 *
 * BRAIN_AGENT_RELAYER_MODE="custodial" or "tenant_signed" both require all
 * three of the signer key, an RPC URL, and a registry address -- identical
 * requirement, because tenant_signed still needs Brain's own key for its
 * one-time initialAdmin bootstrap transaction (see
 * TenantSignedRegistrationRelayer). In NODE_ENV=production, a missing one
 * throws at boot rather than silently leaving every pending_onchain agent
 * stuck forever (same posture as the other rail boot fences:
 * assertEscrowRailHasStateLoader, assertServiceTokenFences).
 *
 * Same altitude as those fences. Factored out for unit testability.
 */

export interface AgentRelayerFenceInput {
  nodeEnv: string | undefined;
  mode: "off" | "custodial" | "tenant_signed";
  privateKeyConfigured: boolean;
  rpcUrlConfigured: boolean;
  registryAddressConfigured: boolean;
}

export function assertAgentRelayerFences(input: AgentRelayerFenceInput): void {
  if (input.mode === "off") return;

  const missing: string[] = [];
  if (!input.privateKeyConfigured) missing.push("BRAIN_AGENT_RELAYER_PRIVATE_KEY");
  if (!input.rpcUrlConfigured) missing.push("BASE_RPC_URL (or RPC_URL)");
  if (!input.registryAddressConfigured) missing.push("MCP_AGENT_REGISTRY_ADDRESS");
  if (missing.length === 0) return;

  if (input.nodeEnv === "production") {
    throw new Error(
      "BRAIN_AGENT_RELAYER_MODE=" +
        input.mode +
        " but missing: " +
        missing.join(", ") +
        ". The on-chain registration relayer cannot submit attestations without all " +
        "three; refusing to start rather than silently leaving every onchain_custodial " +
        "agent stuck pending_onchain. Set BRAIN_AGENT_RELAYER_MODE=off to disable the " +
        "relayer instead.",
    );
  }
}
