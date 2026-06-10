/**
 * Permanent (deterministic) rail-failure classification.
 *
 * A dispatch failure is "permanent" when re-dispatching the SAME payload can
 * never succeed, so every retry burns RPC quota for a guaranteed revert.
 * Reference incident (2026-06-10, Base Sepolia): a payment intent above the
 * session key's per-tx cap reverted with `ExceedsPerTxCap()` (0x49aeece1) and
 * cycled dispatching → reconciling 304+ times in ~10 minutes, because
 * `reconciling` rows are re-claimable and nothing classified the revert as
 * unretryable — the same failure class as the audit-anchor
 * RootAlreadyPublished nonce-burn loop.
 *
 * The on-chain rail tags the BrainError it throws with
 * `details.permanent_failure = true` + `details.decoded_revert` when the
 * revert decodes to a custom error in {@link DETERMINISTIC_SMART_ACCOUNT_REVERTS}.
 * The outbox worker reads the tag via {@link permanentFailureReason} and moves
 * the row to `status='failed'` + fails the intent: a deterministic revert is a
 * DEFINITIVE rail rejection (the whole call reverted, nothing moved), exactly
 * the case PaymentIntentService.failExecution is documented for. The marker is
 * rail-agnostic on purpose — any rail may tag a definitive decline the same way.
 *
 * Deliberately NOT classified as permanent (these stay on the retry/reconcile
 * path; the worker's backoff + total-attempt ceiling bound them instead):
 *  - `BadNonce` — ambiguous: the nonce moved between read and send, so a racing
 *    dispatch (possibly OUR OWN duplicate of this row) may have moved money.
 *    Auto-failing the intent could mis-record a payment that actually landed.
 *  - `ExceedsPerPeriodCap` — the tumbling window resets; a later retry can pass.
 *  - `KeyPaused` / `KeyNotActive` / `AccountIsPaused` — operator-reversible.
 *  - `CallFailed` — the inner target call reverted; possibly transient (e.g. a
 *    paused token) and not provably deterministic from the selector alone.
 *  - `ReentrantCall` — should not occur; treated as anomalous, not permanent.
 */

import { isBrainError } from "@brain/shared";

export interface DeterministicRevert {
  /** 4-byte custom-error selector, lowercase 0x-prefixed (keccak of the signature). */
  readonly selector: string;
  /** Solidity error signature, e.g. "ExceedsPerTxCap()". */
  readonly signature: string;
}

/**
 * BrainSmartAccount custom errors whose revert is deterministic for a fixed
 * payload + session-key grant: the same dispatch can never succeed.
 * Selectors are keccak4 of the signature (verified with `cast sig`).
 */
export const DETERMINISTIC_SMART_ACCOUNT_REVERTS: readonly DeterministicRevert[] = [
  { selector: "0x49aeece1", signature: "ExceedsPerTxCap()" },
  { selector: "0xe356c1d3", signature: "TargetNotAllowed(address)" },
  { selector: "0x3b06e146", signature: "SelectorNotAllowed(bytes4)" },
  { selector: "0x8d3f1013", signature: "PolicyVersionMismatch()" },
  { selector: "0x2572e3a9", signature: "KeyExpired()" },
  { selector: "0xd92e233d", signature: "ZeroAddress()" },
  { selector: "0x0f03f0a0", signature: "ValueNotAllowedInErc20Mode()" },
  { selector: "0xc3f949eb", signature: "NonDecodableSelectorInErc20Mode(bytes4)" },
  { selector: "0x88df9154", signature: "TargetMustEqualCapTokenInErc20Mode()" },
];

const BY_SELECTOR = new Map(DETERMINISTIC_SMART_ACCOUNT_REVERTS.map((r) => [r.selector, r]));
const BY_NAME = new Map(
  DETERMINISTIC_SMART_ACCOUNT_REVERTS.map((r) => [
    r.signature.slice(0, r.signature.indexOf("(")),
    r,
  ]),
);
const NAME_PATTERN = new RegExp(`\\b(${[...BY_NAME.keys()].join("|")})\\b`);
/** A bare 4-byte selector (no trailing hex — long calldata blobs never match). */
const SELECTOR_PATTERN = /0x[0-9a-fA-F]{8}\b/g;

/** Collect err.message down the `cause` chain (viem nests the revert data deep). */
function collectMessages(err: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof err === "string") return [err];
  if (err instanceof Error) {
    return [err.message, ...collectMessages(err.cause, depth + 1)];
  }
  return [];
}

/**
 * Decode an unknown dispatch error against the deterministic-revert table.
 * Matches the decoded error name (when the thrower's ABI knew the error) or
 * the raw 4-byte selector (viem reports undecodable custom errors as
 * `reverted with the following signature: 0x49aeece1`). Returns the full
 * signature, or null when the error is not a known deterministic revert.
 */
export function classifyDeterministicRevert(err: unknown): string | null {
  const text = collectMessages(err).join("\n");
  if (text.length === 0) return null;
  const nameHit = NAME_PATTERN.exec(text);
  if (nameHit !== null && nameHit[1] !== undefined) {
    return BY_NAME.get(nameHit[1])?.signature ?? null;
  }
  for (const match of text.matchAll(SELECTOR_PATTERN)) {
    const revert = BY_SELECTOR.get(match[0].toLowerCase());
    if (revert !== undefined) return revert.signature;
  }
  return null;
}

/**
 * The outbox worker's side of the contract: returns the failure reason when a
 * rail tagged this error as permanent (see module doc), else null (retry path).
 */
export function permanentFailureReason(err: unknown): string | null {
  if (!isBrainError(err)) return null;
  const details = err.details;
  if (details === undefined || details["permanent_failure"] !== true) return null;
  const decoded = details["decoded_revert"];
  return typeof decoded === "string" && decoded.length > 0
    ? `deterministic_revert ${decoded}: ${err.message}`
    : err.message;
}
