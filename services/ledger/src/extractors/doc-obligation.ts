/**
 * Document → Ledger obligation extractor (parser `doc_obligation_v1`).
 *
 * Promotes a `raw_parsed` row produced by the document_extractor agent into
 * an obligation (a payable/receivable) plus the counterparty it is owed
 * to/from. This is the deterministic Ledger-side half of RFC 0004: all
 * model judgment already happened in the Raw-contributing agent, so this
 * extractor only maps an already-structured payload onto typed rows.
 *
 * The obligations table requires a counterparty_id (NOT NULL FK), so a
 * document's named party is resolved/created first, then the obligation is
 * written referencing it. Both rows are written `agent_contributed`, so the
 * §3.2 ceiling caps their confidence at 0.5.
 */

import { brainError, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";

const OBLIGATION_TYPES = [
  "bill",
  "invoice",
  "subscription",
  "loan",
  "rent",
  "payroll",
  "tax",
  "card_statement",
  "other",
] as const;
type ObligationType = (typeof OBLIGATION_TYPES)[number];

const OBLIGATION_STATUSES = [
  "upcoming",
  "due",
  "paid",
  "overdue",
  "cancelled",
  "disputed",
] as const;
type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

/** Validated shape of a `doc_obligation_v1` raw_parsed payload. */
export interface DocObligationPayload {
  counterparty_name: string;
  /** payable = we owe (vendor); receivable = owed to us (customer). */
  direction: "payable" | "receivable";
  type: ObligationType;
  amount: string;
  currency: string;
  due_date: string;
  minimum_due?: string;
  status: ObligationStatus;
  recurrence?: string;
}

export interface DocObligationExtractInput {
  rawParsedId: string;
  rawArtifactId: string;
  payload: Record<string, unknown>;
  /** Confidence from the raw_parsed row; capped to <= 0.5 downstream. */
  confidence: number;
}

export interface ExtractedObligationRow {
  entity: "counterparty" | "obligation";
  id: string;
}

function asNonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw brainError(
      "ledger_row_invalid",
      `doc_obligation_v1: ${field} must be a non-empty string`,
    );
  }
  return v;
}

/**
 * Validate and normalize a `doc_obligation_v1` payload. Pure (no IO) so it is
 * unit-testable. Throws `ledger_row_invalid` on any shape violation rather
 * than writing a malformed row.
 */
export function parseDocObligationPayload(raw: Record<string, unknown>): DocObligationPayload {
  const counterpartyName = asNonEmptyString(raw["counterparty_name"], "counterparty_name");

  const direction = raw["direction"];
  if (direction !== "payable" && direction !== "receivable") {
    throw brainError(
      "ledger_row_invalid",
      "doc_obligation_v1: direction must be payable|receivable",
    );
  }

  const type = raw["type"];
  if (typeof type !== "string" || !OBLIGATION_TYPES.includes(type as ObligationType)) {
    throw brainError(
      "ledger_row_invalid",
      `doc_obligation_v1: type must be one of ${OBLIGATION_TYPES.join("|")}`,
    );
  }

  const amount = asNonEmptyString(raw["amount"], "amount");
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw brainError(
      "ledger_row_invalid",
      "doc_obligation_v1: amount must be a non-negative decimal string",
    );
  }

  const currency = asNonEmptyString(raw["currency"], "currency");
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw brainError(
      "ledger_row_invalid",
      "doc_obligation_v1: currency must be a 3-letter ISO 4217 code",
    );
  }

  const dueDate = asNonEmptyString(raw["due_date"], "due_date");
  if (Number.isNaN(new Date(dueDate).getTime())) {
    throw brainError("ledger_row_invalid", "doc_obligation_v1: due_date must be a valid date-time");
  }

  const rawStatus = raw["status"];
  const status: ObligationStatus =
    rawStatus === undefined
      ? "upcoming"
      : OBLIGATION_STATUSES.includes(rawStatus as ObligationStatus)
        ? (rawStatus as ObligationStatus)
        : (() => {
            throw brainError(
              "ledger_row_invalid",
              `doc_obligation_v1: status must be one of ${OBLIGATION_STATUSES.join("|")}`,
            );
          })();

  const minimumDue = raw["minimum_due"];
  if (
    minimumDue !== undefined &&
    (typeof minimumDue !== "string" || !/^\d+(\.\d+)?$/.test(minimumDue))
  ) {
    throw brainError(
      "ledger_row_invalid",
      "doc_obligation_v1: minimum_due must be a non-negative decimal string",
    );
  }

  const recurrence = raw["recurrence"];
  if (recurrence !== undefined && typeof recurrence !== "string") {
    throw brainError("ledger_row_invalid", "doc_obligation_v1: recurrence must be a string");
  }

  return {
    counterparty_name: counterpartyName,
    direction,
    type: type as ObligationType,
    amount,
    currency,
    due_date: dueDate,
    status,
    ...(minimumDue !== undefined ? { minimum_due: minimumDue } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
  };
}

/**
 * Validate a document payload. As of the canonical cutover (RFC 0005) this is a
 * NO-OP for the Ledger: document obligations now flow Raw -> canonical (the
 * doc_obligation canonical projector, provenance agent_contributed, confidence
 * capped) -> Ledger projection, the same path the Merge connector uses. The
 * parser stays registered (validating, then returning no rows) so
 * LedgerService.normalize records the raw_parsed row as consumed in
 * normalization_log; the canonical projector consumes it independently. A
 * malformed payload still throws here rather than landing silently.
 */
export async function normalizeDocObligationArtifact(
  _pool: Pool,
  _audit: AuditEmitter,
  _ctx: ServiceCallContext,
  input: DocObligationExtractInput,
): Promise<ExtractedObligationRow[]> {
  parseDocObligationPayload(input.payload); // validate; throws on malformed
  return [];
}
