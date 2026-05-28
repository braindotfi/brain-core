/**
 * Agent on-chain registration relayer — RFC 0002 Phase C (O-3:
 * off-chain `pending_onchain` + async relayer).
 *
 * When an owner registers an agent it lands `pending_onchain` (see
 * AgentService.register). A relayer then submits the agent's scope attestation
 * to `BrainMCPAgentRegistry` and, on confirmation, the agent flips to `active`
 * (the state SIWX-prod requires before it can mint a usable token).
 *
 * FAIL-CLOSED by default. The KMS-backed signer + Base RPC that actually submit
 * the tx are deferred live-wiring (the same audit-gated on-chain territory as the
 * x402 / escrow rails). Until a real relayer is configured, the registry stays
 * `pending_onchain` — it is NEVER faked to `active`. This mirrors the rail
 * boot-fence: no money/identity path goes live by accident.
 */

/** The hash-only inputs a relayer needs to attest an agent on-chain (no PII). */
export interface AgentRegistrationRequest {
  readonly agentId: string;
  readonly tenantId: string;
  /** The agent's on-chain address (the registry key). */
  readonly onchainAddress: string;
  /** keccak256 scope attestation hash (hex), matching the agents row. */
  readonly scopeHash: string;
}

export interface AgentRegistrationResult {
  /** The confirmed BrainMCPAgentRegistry attestation tx hash. */
  readonly txHash: string;
}

export interface AgentRegistrationRelayer {
  /** True only when a real on-chain signer/RPC is wired; false ⇒ fail-closed. */
  readonly configured: boolean;
  /**
   * Submit the scope attestation and resolve with the tx hash once confirmed.
   * Rejects when unconfigured (the agent then stays `pending_onchain`).
   */
  submitRegistration(req: AgentRegistrationRequest): Promise<AgentRegistrationResult>;
}

/**
 * The default relayer: refuses to act. `configured` is false and
 * `submitRegistration` rejects, so an agent can never be promoted to `active`
 * without a real on-chain relayer wired in. (Mirrors the *StubRail fail-closed
 * posture.)
 */
export class UnconfiguredRegistrationRelayer implements AgentRegistrationRelayer {
  public readonly configured = false;

  public submitRegistration(_req: AgentRegistrationRequest): Promise<AgentRegistrationResult> {
    return Promise.reject(
      new Error(
        "agent on-chain registration relayer is not configured; agent stays pending_onchain " +
          "(deferred live-wiring — KMS signer + Base RPC, audit-gated)",
      ),
    );
  }
}
