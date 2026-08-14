/**
 * Agent on-chain registration relayer -- RFC 0002 Phase C (O-3:
 * off-chain `pending_onchain` + async relayer).
 *
 * When an owner registers an agent it lands `pending_onchain` (see
 * AgentService.register). A relayer then submits the agent's scope attestation
 * to `BrainMCPAgentRegistry` and, on confirmation, the agent flips to `active`
 * (the state SIWX-prod requires before it can mint a usable token).
 *
 * FAIL-CLOSED by default. Until a real relayer is configured, the registry
 * stays `pending_onchain` -- it is NEVER faked to `active`. This mirrors the
 * rail boot-fence: no money/identity path goes live by accident.
 *
 * Two attested modes, two relayer shapes (increments 3 and 4):
 *   - "onchain_custodial" -- Brain's own configured key is seated as the
 *     tenant's signer and signs both phases. Implemented by
 *     KmsCustodialRegistrationRelayer (relayers/kms-custodial.ts).
 *   - "tenant_signed" -- the tenant's own wallet signs; Brain only relays a
 *     signature the tenant already produced. Not yet implemented; every
 *     relayer built so far rejects this mode.
 */

export type AttestationRelayerMode = "tenant_signed" | "onchain_custodial";

/** The hash-only inputs a relayer needs to attest an agent on-chain (no PII). */
export interface AgentRegistrationRequest {
  readonly agentId: string;
  readonly tenantId: string;
  /** The agent's on-chain address (the registry key). */
  readonly onchainAddress: string;
  /** keccak256 scope attestation hash (hex), matching the agents row. */
  readonly scopeHash: string;
  /** Which attested path this registration uses; a relayer must reject any mode it does not implement. */
  readonly mode: AttestationRelayerMode;
  /**
   * Tenant-signed mode only (increment 4): the tenant's own signer address
   * and a signature it already produced. Accepted here but unused until a
   * tenant-signed relayer exists.
   */
  readonly tenantSignerAddress?: string;
  readonly tenantSignature?: string;
}

export interface AgentRegistrationResult {
  /**
   * The confirmed BrainMCPAgentRegistry attestation tx hash. Null when a
   * crashed earlier attempt already mined the registration on-chain and this
   * call recovered that instead of broadcasting a new one (see
   * `alreadyRegistered` and KmsCustodialRegistrationRelayer).
   */
  readonly txHash: string | null;
  /** True when submitRegistration recovered an already-mined registration instead of broadcasting a new tx. */
  readonly alreadyRegistered?: boolean;
}

/**
 * The EIP-712 payload a tenant-designated signer must sign for tier 2
 * (`tenant_signed`), returned by `POST /agents` at creation time and by
 * `AgentRegistrationRelayer.buildAttestationPayload` (increment 4). Pure/
 * synchronous: no chain call, just domain + type + digest construction, so a
 * caller can display or re-derive it without talking to the RPC.
 */
export interface AttestationPayload {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, unknown>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
  /** keccak256 EIP-712 digest of domain/types/primaryType/message -- what the tenant's wallet actually signs. */
  readonly digest: string;
}

export interface AgentRegistrationRelayer {
  /** True only when a real on-chain signer/RPC is wired; false ⇒ fail-closed. */
  readonly configured: boolean;
  /**
   * Which attestation_mode(s) this relayer instance handles. A configured
   * relayer still rejects (via submitRegistration) any request whose `mode`
   * is not in this list -- this is the CHEAP pre-check POST /agents uses to
   * decide whether to even attempt a request, without a network call.
   */
  readonly supportedModes: readonly AttestationRelayerMode[];
  /**
   * Submit the scope attestation and resolve with the tx hash once confirmed.
   * Rejects when unconfigured (the agent then stays `pending_onchain`), or
   * when `req.mode` is a mode this relayer does not implement.
   */
  submitRegistration(req: AgentRegistrationRequest): Promise<AgentRegistrationResult>;
  /**
   * Tier 2 only: build the EIP-712 payload + digest the tenant's designated
   * signer must sign, without broadcasting anything. Absent on relayers that
   * do not support "tenant_signed" (e.g. KmsCustodialRegistrationRelayer).
   */
  buildAttestationPayload?(input: {
    agentId: string;
    tenantId: string;
    onchainAddress: string;
    scopeHash: string;
  }): AttestationPayload;
}

/**
 * The default relayer: refuses to act. `configured` is false and
 * `submitRegistration` rejects, so an agent can never be promoted to `active`
 * without a real on-chain relayer wired in. (Mirrors the *StubRail fail-closed
 * posture.)
 */
export class UnconfiguredRegistrationRelayer implements AgentRegistrationRelayer {
  public readonly configured = false;
  public readonly supportedModes: readonly AttestationRelayerMode[] = [];

  public submitRegistration(_req: AgentRegistrationRequest): Promise<AgentRegistrationResult> {
    return Promise.reject(
      new Error(
        "agent on-chain registration relayer is not configured; agent stays pending_onchain " +
          "(set BRAIN_AGENT_RELAYER_MODE=custodial or tenant_signed plus the signer/RPC/registry " +
          "config to enable it)",
      ),
    );
  }
}
