/**
 * Ledger obligation vocabulary: the single source of truth for
 * ledger_obligations.type (services/ledger/migrations/0007_ledger_obligations.sql,
 * widened by services/ledger/migrations/0054_ledger_obligations_dispute_type.sql)
 * and for the decimal-amount shape every obligation writer expects.
 *
 * canonical_obligation.type is unconstrained TEXT (services/canonical), but
 * every row canonical projects eventually lands in ledger_obligations through
 * services/ledger/src/projection/obligations.ts, which writes `type` verbatim.
 * Both services already depend on @brain/shared, so this is what they import
 * instead of each keeping (and silently drifting from) their own copy of the
 * allowed set -- see connector-ledger.test.ts's vocabulary guard and
 * services/canonical/src/projectors/doc-obligation.ts's validation.
 */

export const LEDGER_OBLIGATION_TYPES = [
  "bill",
  "invoice",
  "subscription",
  "loan",
  "rent",
  "payroll",
  "tax",
  "card_statement",
  "dispute",
  "other",
] as const;

export type LedgerObligationType = (typeof LEDGER_OBLIGATION_TYPES)[number];

export function isLedgerObligationType(v: unknown): v is LedgerObligationType {
  return typeof v === "string" && (LEDGER_OBLIGATION_TYPES as readonly string[]).includes(v);
}

/** Non-negative plain decimal string, e.g. "1250.00". No exponent, no sign. */
export const LEDGER_DECIMAL_AMOUNT_RE = /^\d+(\.\d+)?$/;
