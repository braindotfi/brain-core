/**
 * Coinbase Spend Permission — the open-ecosystem (4337) authorization
 * (RFC 0001 §7.5, Phase 4).
 *
 * An external Coinbase Smart Wallet grants a `spender` a recurring USDC allowance
 * (the on-chain `SpendPermissionManager` construct). This module is the PURE,
 * deterministic validation + projection that lets Brain treat that permission as
 * a settlement authorization and route it through the SAME PaymentIntent → §6
 * gate → audit path as the internal session-key flow. It performs no I/O — the
 * on-chain "is this permission actually granted / not revoked" read is a
 * deferred, injected step (mirrors the rails' SDK construction).
 *
 * Field-for-field, a Spend Permission maps onto a `BrainSmartAccount` session
 * key + cap (see `toSessionKeyShape`), so the gate's EXISTING checks cover the
 * open path: `allowance`/`period` → the §6 micropayment window cap (check 8.5);
 * `token` → the x402 payment-context check (6.5, USDC); `spender`/identity →
 * checks 1 + 5.5. No new gate check is required.
 *
 * Hash-only (RFC §3): only addresses, amounts, and a bytes32 salt — no PII.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/** A Coinbase Spend Permission (subset Brain needs). All amounts are decimal strings. */
export interface SpendPermission {
  /** The funding Coinbase Smart Wallet. */
  readonly account: string;
  /** Who may pull funds (the Brain settlement address / payee). */
  readonly spender: string;
  /** ERC-20 settled — must equal the configured USDC-on-Base address. */
  readonly token: string;
  /** Max cumulative spend per `period` (token units, decimal string). */
  readonly allowance: string;
  /** Rolling-window length in seconds. */
  readonly period: number;
  /** Not-before (unix seconds). */
  readonly start: number;
  /** Not-after (unix seconds). */
  readonly end: number;
  /** Uniqueness salt (bytes32 hex). */
  readonly salt: string;
}

/** The settlement a permission is being asked to authorize. */
export interface SpendRequest {
  /** Expected settlement asset — the configured USDC-on-Base address. */
  readonly token: string;
  /** Expected spender (Brain settlement address / payee). */
  readonly spender: string;
  /** Settlement amount (decimal string). */
  readonly amount: string;
  /** Current time (unix seconds). */
  readonly nowSeconds: number;
}

export interface SpendValidation {
  readonly valid: boolean;
  readonly failures: readonly string[];
}

/**
 * Deterministically validate that a Spend Permission authorizes a settlement.
 * Returns every failure (not just the first) so the caller can surface a precise
 * reason. Pure — no on-chain read (that, plus revocation, is injected later).
 */
export function validateSpendPermission(p: SpendPermission, req: SpendRequest): SpendValidation {
  const failures: string[] = [];

  // Shape.
  if (!ADDRESS.test(p.account)) failures.push("account is not a 0x address");
  if (!ADDRESS.test(p.spender)) failures.push("spender is not a 0x address");
  if (!ADDRESS.test(p.token)) failures.push("token is not a 0x address");
  if (!BYTES32.test(p.salt)) failures.push("salt is not a bytes32 hex");
  if (!DECIMAL.test(p.allowance) || cmpDecimal(p.allowance, "0") <= 0) {
    failures.push("allowance must be a positive decimal");
  }
  if (!DECIMAL.test(req.amount) || cmpDecimal(req.amount, "0") <= 0) {
    failures.push("amount must be a positive decimal");
  }
  if (!Number.isInteger(p.period) || p.period <= 0)
    failures.push("period must be a positive integer");
  if (p.end < p.start) failures.push("permission end is before its start");

  // Semantics (only when the relevant fields are well-formed).
  if (ADDRESS.test(p.token) && ADDRESS.test(req.token) && !addrEq(p.token, req.token)) {
    failures.push("token does not match the expected settlement asset (USDC on Base)");
  }
  if (ADDRESS.test(p.spender) && ADDRESS.test(req.spender) && !addrEq(p.spender, req.spender)) {
    failures.push("spender does not match the expected settlement spender");
  }
  if (
    DECIMAL.test(p.allowance) &&
    DECIMAL.test(req.amount) &&
    cmpDecimal(req.amount, p.allowance) > 0
  ) {
    failures.push("amount exceeds the permission allowance");
  }
  if (req.nowSeconds < p.start) failures.push("permission is not yet valid");
  if (req.nowSeconds > p.end) failures.push("permission has expired");

  return { valid: failures.length === 0, failures };
}

/**
 * Project the permission's `allowance`/`period` onto the §6 micropayment window
 * cap (gate check 8.5), so the off-chain gate and the on-chain permission agree.
 */
export function toMicropaymentWindowCap(
  p: SpendPermission,
  currency = "USDC",
): { currency: string; value: string; window_seconds: number } {
  return { currency, value: p.allowance, window_seconds: p.period };
}

/**
 * Project a Spend Permission onto the `BrainSmartAccount` session-key shape
 * (RFC 0001 §7.5 — the two authorizations are the same shape). Illustrative /
 * for parity assertions; the internal path is unchanged.
 */
export function toSessionKeyShape(p: SpendPermission): {
  holder: string;
  maxPerPeriod: string;
  periodSeconds: number;
  validAfter: number;
  validUntil: number;
} {
  return {
    holder: p.spender,
    maxPerPeriod: p.allowance,
    periodSeconds: p.period,
    validAfter: p.start,
    validUntil: p.end,
  };
}

/** EVM-address equality (case-insensitive; both already shape-checked). */
function addrEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Exact decimal-string compare (scaled to 8 dp; covers USDC's 6) without f64
 * loss. Returns -1/0/1. Mirrors the per-module decimal helpers elsewhere in the
 * codebase (gate, policy VM, invoice shortcut) — kept local so this module is
 * dependency-free. Inputs are validated as `DECIMAL` by the caller.
 */
function cmpDecimal(a: string, b: string): number {
  const sa = toScaled8(a);
  const sb = toScaled8(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function toScaled8(s: string): bigint {
  const [intPart = "0", fracPart = ""] = s.split(".");
  const frac = (fracPart + "00000000").slice(0, 8);
  return BigInt((intPart === "" ? "0" : intPart) + frac);
}
