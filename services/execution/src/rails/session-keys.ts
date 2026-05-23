/**
 * Per-task minimum-privilege session keys (Agent Autonomy v3, 3.3).
 *
 * Instead of one long-lived agent session key, derive a one-time child key per
 * approved PaymentIntent, bounded to the EXACT counterparty (allowedTargets),
 * EXACT amount (maxPerTx == maxPerPeriod), and a short validity (~10 min). The
 * agent's main key only grants child keys; a compromised worker can therefore
 * spend at most one in-flight intent's authority. Related: ERC-7715.
 *
 * This helper produces the BrainSmartAccount.SessionKey params the owner passes
 * to grantSessionKey. Resolving a ledger counterparty_id to its on-chain payout
 * address is the caller's responsibility (cross-service lookup).
 */

/** Mirrors the BrainSmartAccount.SessionKey struct (values as strings for ABI encoding). */
export interface PerTaskSessionKeyParams {
  readonly holder: string;
  readonly validAfter: string;
  readonly validUntil: string;
  readonly allowedTargets: readonly string[];
  readonly allowedSelectors: readonly string[];
  readonly maxPerTx: string;
  readonly maxPerPeriod: string;
  readonly periodSeconds: string;
  readonly policyVersion: string;
}

export interface DerivePerTaskKeyInput {
  /** The one-time child key holder (the worker/session principal). */
  readonly holder: string;
  /** The exact on-chain target this key may call (the resolved counterparty). */
  readonly targetAddress: string;
  /** Exact amount in base units (wei) — both per-tx and per-period cap. */
  readonly amountWei: bigint | string;
  /** Registered policy version digest (0x-hex) the key is bound to. */
  readonly policyVersion: string;
  /** Allowed selectors (empty = any). Restrict to the rail's transfer selector in prod. */
  readonly allowedSelectors?: readonly string[];
  /** Unix seconds "now"; defaults to Date.now()/1000. */
  readonly nowSeconds?: number;
  /** Validity window in seconds; defaults to 600 (~10 min). */
  readonly ttlSeconds?: number;
}

export const DEFAULT_TASK_KEY_TTL_SECONDS = 600;

export function derivePerTaskSessionKey(input: DerivePerTaskKeyInput): PerTaskSessionKeyParams {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_TASK_KEY_TTL_SECONDS;
  const amount = (
    typeof input.amountWei === "bigint" ? input.amountWei : BigInt(input.amountWei)
  ).toString();
  return {
    holder: input.holder,
    validAfter: String(now),
    validUntil: String(now + ttl),
    allowedTargets: [input.targetAddress], // exactly this counterparty
    allowedSelectors: input.allowedSelectors ?? [],
    maxPerTx: amount, // exact amount
    maxPerPeriod: amount, // and no more across the key's lifetime
    periodSeconds: String(ttl), // the accounting window == the key lifetime
    policyVersion: input.policyVersion,
  };
}
