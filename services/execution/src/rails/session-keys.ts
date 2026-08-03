/**
 * Per-task minimum-privilege session keys (Agent Autonomy v3, 3.3).
 *
 * Instead of one long-lived agent session key, derive a one-time child key per
 * approved PaymentIntent, bounded to the EXACT recipient, the EXACT amount
 * (maxPerTx == maxPerPeriod), and a short validity (~10 min). The agent's main
 * key only grants child keys; a compromised worker can therefore spend at most
 * one in-flight intent's authority. Related: ERC-7715.
 *
 * Two properties this file used to claim but not deliver, both now enforced by
 * BrainSmartAccount:
 *
 *   - "bounded to the EXACT counterparty". In ERC20 mode the only permitted
 *     TARGET is the token contract, so the payee lives in calldata. It is now
 *     bound through `allowedRecipients`, which the account checks against the
 *     decoded `to` argument.
 *   - "and no more across the key's lifetime". Spend windows used to be
 *     aligned to the unix epoch. A per-task key's lifetime equals one period,
 *     so a boundary almost always fell inside it and the key could spend its
 *     full cap TWICE. Windows now anchor to `validAfter`, which this helper
 *     sets to the issuance time.
 *
 * This helper produces the BrainSmartAccount.SessionKey params the owner passes
 * to grantSessionKey. Resolving a ledger counterparty_id to its on-chain payout
 * address is the caller's responsibility (cross-service lookup).
 */

/** Mirrors BrainSmartAccount.CapMode. Values match the Solidity enum ordinals. */
export enum CapMode {
  NATIVE = 0,
  ERC20 = 1,
  CALL = 2,
}

/** Mirrors the BrainSmartAccount.SessionKey struct (values as strings for ABI encoding). */
export interface PerTaskSessionKeyParams {
  readonly holder: string;
  readonly validAfter: string;
  readonly validUntil: string;
  readonly allowedTargets: readonly string[];
  readonly allowedSelectors: readonly string[];
  readonly capMode: CapMode;
  readonly capToken: string;
  readonly allowedRecipients: readonly string[];
  readonly capAmountOffset: string;
  readonly maxPerTx: string;
  readonly maxPerPeriod: string;
  readonly periodSeconds: string;
  readonly policyVersion: string;
}

export interface DerivePerTaskKeyInput {
  /** The one-time child key holder (the worker/session principal). */
  readonly holder: string;
  /**
   * The resolved counterparty: the address that must RECEIVE the funds.
   *
   * In ERC20 mode this becomes `allowedRecipients` (the decoded `to`), not
   * `allowedTargets` — the target is forced to the token contract. In NATIVE
   * mode it is the call target, since a plain value transfer has no calldata.
   */
  readonly recipientAddress: string;
  /**
   * Token whose raw units denominate the cap. Pass the zero address for native
   * ETH transfers, whose cap is denominated in wei.
   */
  readonly capToken: string;
  /** Exact raw integer units in capToken units, or wei for native ETH. */
  readonly amountRawUnits: bigint | string;
  /** Registered policy version digest (0x-hex) the key is bound to. */
  readonly policyVersion: string;
  /**
   * Allowed selectors. ERC20 mode only, and a subset of
   * {transfer, transferFrom} — `approve` is rejected at grant because an
   * allowance outlives the accounting window. Ignored in NATIVE mode, which
   * forbids calldata outright.
   */
  readonly allowedSelectors?: readonly string[];
  /** Unix seconds "now"; defaults to Date.now()/1000. */
  readonly nowSeconds?: number;
  /** Validity window in seconds; defaults to 600 (~10 min). */
  readonly ttlSeconds?: number;
}

export const DEFAULT_TASK_KEY_TTL_SECONDS = 600;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ERC20_TRANSFER = "0xa9059cbb";
const ERC20_TRANSFER_FROM = "0x23b872dd";

export function derivePerTaskSessionKey(input: DerivePerTaskKeyInput): PerTaskSessionKeyParams {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_TASK_KEY_TTL_SECONDS;
  const amount = (
    typeof input.amountRawUnits === "bigint" ? input.amountRawUnits : BigInt(input.amountRawUnits)
  ).toString();

  const isNative = input.capToken.toLowerCase() === ZERO_ADDRESS;

  // NATIVE: a plain value transfer to the recipient, no calldata at all.
  // ERC20:  target is forced to the token; the recipient is bound separately.
  const base = {
    holder: input.holder,
    // The spend window anchors here, so a per-task key's accounting window is
    // exactly its lifetime rather than whichever epoch bucket it lands in.
    validAfter: String(now),
    validUntil: String(now + ttl),
    maxPerTx: amount, // exact amount
    maxPerPeriod: amount, // and no more across the key's lifetime
    periodSeconds: String(ttl), // the accounting window == the key lifetime
    policyVersion: input.policyVersion,
    capAmountOffset: "0",
  } as const;

  if (isNative) {
    return {
      ...base,
      allowedTargets: [input.recipientAddress],
      allowedSelectors: [],
      capMode: CapMode.NATIVE,
      capToken: ZERO_ADDRESS,
      allowedRecipients: [],
    };
  }

  return {
    ...base,
    allowedTargets: [input.capToken], // ERC20 mode requires exactly [capToken]
    allowedSelectors: input.allowedSelectors ?? [ERC20_TRANSFER, ERC20_TRANSFER_FROM],
    capMode: CapMode.ERC20,
    capToken: input.capToken,
    allowedRecipients: [input.recipientAddress], // the actual counterparty binding
  };
}
