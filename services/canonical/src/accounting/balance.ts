/**
 * Double-entry arithmetic over canonical journal lines. Pure and exact: amounts
 * are decimal strings, summed as integers scaled to 8 fractional digits (the
 * canonical_journal_line.amount NUMERIC(38,8) scale), so there is no float
 * drift when checking that a journal entry's debits equal its credits.
 *
 * The projector (PR-B) uses isBalanced to record a data-quality signal on each
 * entry; it never rejects an unbalanced entry (sources are authoritative for
 * what they posted), but a persistent imbalance is worth surfacing.
 */

import type { LineDirection } from "./types.js";

const SCALE = 8n;
const SCALE_FACTOR = 10n ** SCALE;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export interface DirectionalAmount {
  direction: LineDirection;
  amount: string;
}

/** Parse a plain decimal string to a bigint scaled by 10^8. Throws on garbage. */
export function toScaled(amount: string): bigint {
  const s = amount.trim();
  if (!DECIMAL_RE.test(s)) {
    throw new Error(`not a plain decimal amount: ${amount}`);
  }
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [whole = "0", frac = ""] = body.split(".");
  if (frac.length > Number(SCALE)) {
    throw new Error(`amount exceeds ${SCALE} fractional digits: ${amount}`);
  }
  const scaled =
    BigInt(whole) * SCALE_FACTOR +
    BigInt((frac + "0".repeat(Number(SCALE))).slice(0, Number(SCALE)) || "0");
  return negative ? -scaled : scaled;
}

/** Render a scaled bigint back to a fixed 8-dp decimal string. */
export function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(Number(SCALE), "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export function totalsByDirection(lines: readonly DirectionalAmount[]): {
  debit: string;
  credit: string;
} {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    const scaled = toScaled(line.amount);
    if (line.direction === "debit") debit += scaled;
    else credit += scaled;
  }
  return { debit: fromScaled(debit), credit: fromScaled(credit) };
}

/** The signed debit-minus-credit imbalance as a decimal string ("0.00000000" when balanced). */
export function netImbalance(lines: readonly DirectionalAmount[]): string {
  let net = 0n;
  for (const line of lines) {
    const scaled = toScaled(line.amount);
    net += line.direction === "debit" ? scaled : -scaled;
  }
  return fromScaled(net);
}

export function isBalanced(lines: readonly DirectionalAmount[]): boolean {
  return netImbalance(lines) === "0.00000000";
}
