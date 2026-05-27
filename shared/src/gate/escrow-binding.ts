/**
 * §6 gate check 6.6 — escrow-state-binding types (RFC 0001 §6.2 / §7.6).
 *
 * For a conditional (escrow) settlement, the gate must confirm the on-chain
 * escrow lock matches the PaymentIntent BEFORE a release is gated through: the
 * escrow is still Locked, for the same amount, to the same payee, against the
 * same job-terms commitment. This is the on-chain analogue of evidence-semantic
 * validation — it binds off-chain intent to on-chain state.
 *
 * The read is on-chain (`BrainEscrow.getEscrow`) and lives in services/policy;
 * the gate (in `shared`) consumes it through the injected `resolveEscrowState`
 * GateDependencies hook and must not touch the chain directly. These shared
 * types are the contract between the two — mirroring the duplicate-detector and
 * agent-attestation patterns.
 *
 * Determinism (Standards §6, Principle #5): this is a state + field comparison
 * against the immutable on-chain lock, never a judgment call.
 */

/** Mirrors `IBrainEscrow.State` (contracts/src/IBrainEscrow.sol). */
export type EscrowOnchainState = "None" | "Locked" | "Released" | "Refunded";

export interface EscrowStateInput {
  readonly tenantId: string;
  /** The on-chain escrow id carried on the PaymentIntent. */
  readonly escrowId: string;
}

export interface ResolvedEscrowState {
  /** Lifecycle state read from the chain; release is gated only from `Locked`. */
  readonly state: EscrowOnchainState;
  /** On-chain payer (funder) address. */
  readonly payer: string;
  /** On-chain payee (beneficiary) address — must match the release counterparty. */
  readonly payee: string;
  /** ERC-20 settled (USDC on Base). */
  readonly token: string;
  /** Locked amount as a decimal string (compared against the intent amount). */
  readonly amount: string;
  /** keccak256 commitment of the off-chain job terms (hash-only, RFC §3). */
  readonly jobTermsHash: string;
}
