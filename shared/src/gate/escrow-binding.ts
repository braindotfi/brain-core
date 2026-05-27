/**
 * §6 gate check 6.6 — escrow-state-binding types (RFC 0001 §6.2 / §7.6).
 *
 * For a conditional (escrow) settlement, the gate must confirm the on-chain
 * escrow lock matches the PaymentIntent BEFORE a release is gated through: the
 * escrow is still `Locked`, has enough **remaining** (unreleased / unrefunded)
 * balance to cover this release, pays the same payee, against the same job-terms
 * commitment. This is the on-chain analogue of evidence-semantic validation —
 * it binds off-chain intent to on-chain state.
 *
 * `BrainEscrow` settles **incrementally** (RFC 0001 §7.6): `release` and
 * `refund` each move a partial amount, supporting milestone payments and arbiter
 * dispute-splits, and the escrow stays `Locked` until `released + refunded`
 * reaches the full `amount` (then `Settled`, terminal). So the gate binds the
 * intent's release amount against `remaining`, not against the total locked
 * `amount` — an exact-amount match would wrongly reject every milestone after
 * the first.
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
export type EscrowOnchainState = "None" | "Locked" | "Settled";

export interface EscrowStateInput {
  readonly tenantId: string;
  /** The on-chain escrow id carried on the PaymentIntent. */
  readonly escrowId: string;
}

export interface ResolvedEscrowState {
  /**
   * Lifecycle state read from the chain. A release is gated only from `Locked`;
   * `Settled` (released + refunded == amount) is terminal and rejects.
   */
  readonly state: EscrowOnchainState;
  /** On-chain payer (funder) address. */
  readonly payer: string;
  /** On-chain payee (beneficiary) address — must match the release counterparty. */
  readonly payee: string;
  /** ERC-20 settled (USDC on Base). */
  readonly token: string;
  /** Total locked amount as a decimal string. */
  readonly amount: string;
  /** Cumulative amount already released to the payee (decimal string). */
  readonly released: string;
  /** Cumulative amount already refunded to the payer (decimal string). */
  readonly refunded: string;
  /**
   * Unsettled balance left to release or refund, as a decimal string —
   * `amount - released - refunded`, computed by the resolver in exact base
   * units. The gate binds the intent's release amount against this (the release
   * must satisfy `remaining >= intent.amount`), supporting partial milestones.
   */
  readonly remaining: string;
  /** keccak256 commitment of the off-chain job terms (hash-only, RFC §3). */
  readonly jobTermsHash: string;
}
