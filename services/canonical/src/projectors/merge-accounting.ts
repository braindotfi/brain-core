/**
 * Project Merge accounting raw_parsed pages into canonical accounting records
 * (ingestion architecture §12, Phase 5, PR-B).
 *
 * The Merge connector already lands gl_account and journal_entry pages in
 * raw_parsed (parser `merge_accounting_v1`, payload {object_type,
 * merge_integration, objects}) but `merge_accounting_v1` drops them: the
 * compact Ledger has no home for double-entry structure. This projector is
 * that home. The mapping functions here are pure — the worker (worker.ts)
 * supplies the rows and persists the results.
 *
 * Field mapping follows the Merge unified accounting model. Shared, queryable
 * fields become canonical columns; the verbatim provider object is retained in
 * namespaced `extensions.merge` so nothing is lost (§12). The Merge journal
 * line encodes debit/credit by the SIGN of `net_amount` (positive = debit,
 * negative = credit); canonical splits that into an explicit `direction` plus a
 * non-negative `amount`, with the raw signed value kept in the line extensions.
 */

import type {
  AccountClassification,
  CanonicalProvenance,
  LineDirection,
} from "../accounting/types.js";
import { classifyAccount } from "../accounting/classify.js";

/** The id this projector records in canonical_projection_log. */
export const MERGE_ACCOUNTING_PROJECTOR = "merge_accounting_canonical_v1" as const;

/** The raw_parsed parser this projector consumes. */
export const MERGE_ACCOUNTING_PARSER = "merge_accounting_v1" as const;

/** Object types this projector promotes (others stay in raw_parsed). */
export const PROJECTABLE_OBJECT_TYPES = ["gl_account", "journal_entry"] as const;
export type ProjectableObjectType = (typeof PROJECTABLE_OBJECT_TYPES)[number];

/** Provenance + evidence shared by every record projected from one page. */
export interface ProjectionCommon {
  provenance: CanonicalProvenance;
  confidence: number | null;
  sourceIds: string[];
  evidenceIds: string[];
}

export interface GlAccountUpsert {
  sourceSystem: string;
  sourceNaturalKey: string;
  name: string;
  classification: AccountClassification;
  accountNumber: string | null;
  currency: string | null;
  status: string | null;
  extensions: Record<string, unknown>;
  common: ProjectionCommon;
}

export interface JournalLineUpsert {
  lineNumber: number;
  glAccountKey: string | null;
  direction: LineDirection;
  amount: string;
  currency: string | null;
  description: string | null;
  extensions: Record<string, unknown>;
}

export interface JournalEntryUpsert {
  sourceSystem: string;
  sourceNaturalKey: string;
  postedAt: string | null;
  memo: string | null;
  currency: string | null;
  status: string | null;
  lines: JournalLineUpsert[];
  extensions: Record<string, unknown>;
  common: ProjectionCommon;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function currency(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const up = s.toUpperCase();
  return /^[A-Z]{3}$/.test(up) ? up : null;
}

/** Normalize a Merge amount (number or string) to a plain, non-exponent decimal string. */
export function toPlainDecimal(v: unknown): string | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const s = String(v);
    return /[eE]/.test(s) ? null : s;
  }
  if (typeof v === "string") {
    const s = v.trim();
    return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
  }
  return null;
}

/** Split a signed Merge net_amount into an explicit direction + non-negative amount. */
export function splitSignedAmount(v: unknown): { direction: LineDirection; amount: string } | null {
  const decimal = toPlainDecimal(v);
  if (decimal === null) return null;
  const negative = decimal.startsWith("-");
  const magnitude = negative ? decimal.slice(1) : decimal;
  return { direction: negative ? "credit" : "debit", amount: magnitude };
}

export function projectGlAccount(
  raw: unknown,
  sourceSystem: string,
  common: ProjectionCommon,
): GlAccountUpsert | null {
  const obj = asRecord(raw);
  if (obj === null) return null;
  const key = str(obj["id"]) ?? str(obj["remote_id"]);
  if (key === null) return null;
  return {
    sourceSystem,
    sourceNaturalKey: key,
    name: str(obj["name"]) ?? key,
    classification: classifyAccount(str(obj["classification"])),
    accountNumber: str(obj["account_number"]),
    currency: currency(obj["currency"]),
    status: str(obj["status"]),
    extensions: { merge: obj },
    common,
  };
}

export function projectJournalEntry(
  raw: unknown,
  sourceSystem: string,
  common: ProjectionCommon,
): JournalEntryUpsert | null {
  const obj = asRecord(raw);
  if (obj === null) return null;
  const key = str(obj["id"]) ?? str(obj["remote_id"]);
  if (key === null) return null;

  const entryCurrency = currency(obj["currency"]);
  const rawLines = Array.isArray(obj["lines"]) ? obj["lines"] : [];
  const lines: JournalLineUpsert[] = [];
  let lineNumber = 0;
  for (const rawLine of rawLines) {
    const line = asRecord(rawLine);
    if (line === null) continue;
    const split = splitSignedAmount(line["net_amount"]);
    if (split === null) continue; // a line with no usable amount is not a leg
    lineNumber += 1;
    lines.push({
      lineNumber,
      glAccountKey: str(line["account"]),
      direction: split.direction,
      amount: split.amount,
      currency: currency(line["currency"]) ?? entryCurrency,
      description: str(line["description"]),
      extensions: { merge: line },
    });
  }

  return {
    sourceSystem,
    sourceNaturalKey: key,
    postedAt:
      str(obj["transaction_date"]) ?? str(obj["posted_date"]) ?? str(obj["remote_created_at"]),
    memo: str(obj["memo"]),
    currency: entryCurrency,
    status: str(obj["posting_status"]) ?? str(obj["status"]),
    lines,
    extensions: { merge: obj },
    common,
  };
}
