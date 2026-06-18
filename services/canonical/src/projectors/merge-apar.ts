/**
 * Project Merge AP/AR pages (invoice, contact) into canonical obligation +
 * counterparty records (Phase 5 deep refactor, PR-E).
 *
 * Companion to merge-accounting.ts (which handles gl_account / journal_entry).
 * The field mapping mirrors the existing `merge_accounting_v1` Ledger extractor
 * so the eventual cutover (Ledger projects obligations/counterparties FROM
 * canonical) is behaviour-preserving:
 *   - invoice ACCOUNTS_PAYABLE    -> obligation, direction payable, type bill
 *   - invoice ACCOUNTS_RECEIVABLE -> obligation, direction receivable, type invoice
 *   - contact is_supplier -> vendor, is_customer -> customer, else other
 *
 * Pure functions; the worker supplies rows and persists results. The verbatim
 * provider object is retained in `extensions.merge`.
 */

import type { CanonicalProvenance } from "../accounting/types.js";
import type { ProjectionCommon } from "./merge-accounting.js";
import { toPlainDecimal } from "./merge-accounting.js";

export type CounterpartyType = "vendor" | "customer" | "employee" | "merchant" | "other";
export type ObligationDirection = "payable" | "receivable";

export interface CounterpartyUpsert {
  sourceSystem: string;
  sourceNaturalKey: string;
  name: string;
  normalizedName: string | null;
  type: CounterpartyType;
  email: string | null;
  extensions: Record<string, unknown>;
  common: ProjectionCommon;
}

export interface ObligationUpsert {
  sourceSystem: string;
  sourceNaturalKey: string;
  direction: ObligationDirection;
  type: string;
  counterpartySourceKey: string | null;
  amount: string;
  currency: string | null;
  issueDate: string | null;
  dueDate: string | null;
  status: string | null;
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

/** Normalize a display name to a stable comparison key (lowercased, alnum runs joined by _). */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function projectMergeContact(
  raw: unknown,
  sourceSystem: string,
  common: ProjectionCommon,
): CounterpartyUpsert | null {
  const obj = asRecord(raw);
  if (obj === null) return null;
  const key = str(obj["id"]) ?? str(obj["remote_id"]);
  if (key === null) return null;
  const email = str(obj["email_address"]);
  const name = str(obj["name"]) ?? email ?? key;
  const type: CounterpartyType =
    obj["is_supplier"] === true ? "vendor" : obj["is_customer"] === true ? "customer" : "other";
  return {
    sourceSystem,
    sourceNaturalKey: key,
    name,
    normalizedName: normalizeName(name) || null,
    type,
    email: email === null ? null : email.toLowerCase(),
    extensions: { merge: obj },
    common,
  };
}

const PAYABLE = "ACCOUNTS_PAYABLE";
const RECEIVABLE = "ACCOUNTS_RECEIVABLE";

export function projectMergeInvoice(
  raw: unknown,
  sourceSystem: string,
  common: ProjectionCommon,
): ObligationUpsert | null {
  const obj = asRecord(raw);
  if (obj === null) return null;
  const key = str(obj["id"]) ?? str(obj["remote_id"]);
  if (key === null) return null;

  const mergeType = str(obj["type"]);
  const isPayable = mergeType === PAYABLE;
  const isReceivable = mergeType === RECEIVABLE;
  if (!isPayable && !isReceivable) return null; // only AP/AR invoices are obligations

  // Outstanding balance when present, else the total. A fully paid bill
  // (balance 0) still lands so history reconciles. Negative amounts are skipped.
  const amount = toPlainDecimal(obj["balance"]) ?? toPlainDecimal(obj["total_amount"]);
  if (amount === null || amount.startsWith("-")) return null;

  const lineItems = Array.isArray(obj["line_items"]) ? (obj["line_items"] as unknown[]) : [];
  const glAccounts = lineItems
    .map((li) => str(asRecord(li)?.["account"]))
    .filter((a): a is string => a !== null);

  return {
    sourceSystem,
    sourceNaturalKey: key,
    direction: isPayable ? "payable" : "receivable",
    type: isPayable ? "bill" : "invoice",
    counterpartySourceKey: str(obj["contact"]),
    amount,
    currency: currency(obj["currency"]),
    issueDate: str(obj["issue_date"]),
    dueDate: str(obj["due_date"]),
    status: str(obj["status"]),
    extensions: {
      merge: {
        remote_id: str(obj["remote_id"]),
        number: str(obj["number"]),
        gl_accounts: glAccounts,
        line_items: lineItems,
      },
    },
    common,
  };
}

export type { CanonicalProvenance };
