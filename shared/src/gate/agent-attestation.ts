/**
 * §6 gate check 5.5 — agent-counterparty attestation types (RFC 0001 §6.3).
 *
 * When the payee of a PaymentIntent is itself an agent (Phase 1B introduced the
 * `agent` counterparty type + `agent_id`), the gate must confirm the payee is a
 * registered, attested, non-paused agent in `BrainMCPAgentRegistry` BEFORE money
 * moves to it — the M2M-commerce analogue of counterparty verification.
 *
 * The attestation read is on-chain (registry) / DB-backed and lives in
 * services/policy; the gate (in `shared`) consumes it through the injected
 * `attestCounterpartyAgent` GateDependencies hook and must not query the chain or
 * DB directly. These shared types are the contract between the two — mirroring
 * the duplicate-detector pattern (duplicate.ts).
 *
 * Determinism (Standards §6, Principle #5): this is a registry membership +
 * pause-state read, NOT reputation. Reputation may raise/lower a policy
 * threshold elsewhere, but it is never the precondition here.
 */

export interface AgentAttestationInput {
  /**
   * The calling (paying) tenant, for audit context. The registered-and-not-
   * revoked decision itself is tenant-agnostic (see AgentAttestationResult),
   * so implementations are not required to use this to gate the verdict.
   */
  readonly tenantId: string;
  /** The destination counterparty id (a `ledger_counterparties` row). */
  readonly counterpartyId: string;
  /**
   * The counterparty's `agent_id` (Phase 1B). Null when the counterparty is not
   * an agent — callers only invoke this when the payee is an agent, so a null
   * here is itself an attestation failure (an agent payee with no agent id).
   */
  readonly agentId: string | null;
}

export interface AgentAttestationResult {
  /**
   * True ⇒ the payee agent is registered in `BrainMCPAgentRegistry` and not
   * revoked. PRODUCT DECISION: this is tenant-agnostic by design — the
   * registry's agent namespace is global, and a registered agent may be paid
   * by any tenant, not only the one that registered it. That is the
   * canonical cross-org M2M/x402 case (docs/v0.4-open-ecosystem-interop.md
   * §7), not an edge case to reject.
   */
  readonly attested: boolean;
  /** Whether the agent id resolves to a registry entry at all. */
  readonly registered?: boolean;
  /**
   * Whether the registry entry has been revoked (a hard fail).
   *
   * Revocation is TERMINAL in `BrainMCPAgentRegistry`: there is no unpause, and
   * the agentId can never be re-registered or re-attested. This was previously
   * surfaced as `paused`, which implied a recoverable state and sent operators
   * looking for a switch that does not exist.
   */
  readonly revoked?: boolean;
  /** Human-readable reason when `attested` is false (for the audit trail). */
  readonly reason?: string;
}
