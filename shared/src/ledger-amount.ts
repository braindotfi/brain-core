/**
 * Bound check for every Ledger column typed NUMERIC(28,8) (28 total digits,
 * 8 after the decimal point, so at most 20 integer digits):
 * ledger_obligations.amount_due (0007), ledger_invoices.amount_due (0008),
 * ledger_accounts.current_balance/available_balance, and
 * ledger_transactions.amount.
 *
 * Canonical's equivalent columns are deliberately WIDER, NUMERIC(38,8) (30
 * integer digits) -- services/canonical/migrations/0001_canonical_accounting.sql,
 * 0002_canonical_apar.sql -- because canonical's job is to hold whatever a
 * provider or document extractor sent without narrowing it first; that is
 * the layer that stays faithful to source truth. This bound is deliberately
 * NOT pushed down into canonical's schema. A value in the 10^20..10^30 band
 * passes canonical's own `amount >= 0` CHECK fine, then throws an unhandled
 * `22003 numeric field overflow` on the narrower Ledger INSERT.
 *
 * The check is applied at the ingress boundary instead: the canonical
 * doc-obligation projector (the widest door -- untrusted LLM/OCR output with
 * no upstream numeric-format check) and the Ledger projection itself (the
 * last stop before the narrower column, and a backstop for every other
 * canonical projector). Both turn an implausible amount into a clear,
 * diagnosable skipped/quarantined row instead of a raw Postgres exception
 * surfacing deep in a background worker.
 */

const LEDGER_NUMERIC_INTEGER_DIGITS = 20; // NUMERIC(28,8): 28 total - 8 scale

/** `amount` must already be a validated non-negative decimal string (see LEDGER_DECIMAL_AMOUNT_RE). */
export function isPlausibleLedgerAmount(amount: string): boolean {
  const integerPart = amount.split(".")[0] ?? "";
  const digits = integerPart.replace(/^0+(?=\d)/, "").length;
  return digits <= LEDGER_NUMERIC_INTEGER_DIGITS;
}
