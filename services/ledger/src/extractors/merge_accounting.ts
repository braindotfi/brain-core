/**
 * Merge accounting extractor — interprets `merge_accounting_v1` raw_parsed
 * rows (Phase 3 connector 3, Appendix A).
 *
 * Payload shape (produced by the raw interpretation worker from verbatim
 * Merge list pages): { object_type, merge_integration, objects }.
 *
 * MVP canonical mapping, scoped to the wedge AC ("open bills and their
 * vendors land as payable obligations and counterparties with GL coding
 * preserved in extensions"):
 *  - invoice (Merge type ACCOUNTS_PAYABLE)    -> obligation, direction payable, type bill
 *  - invoice (Merge type ACCOUNTS_RECEIVABLE) -> obligation, direction receivable, type invoice
 *  - contact -> counterparty (vendor when is_supplier, customer when
 *    is_customer, else other), namespaced merge metadata
 *
 * GL coding (line-item account references), the Merge remote_id (the
 * original platform's id, e.g. the NetSuite internal id), and the underlying
 * integration name are preserved in namespaced `metadata.merge` extensions —
 * never flattened into shared columns (§12).
 *
 * Other object types (gl_account, journal_entry, payment, tax_rate) are
 * pulled and retained in Raw + raw_parsed but not yet promoted: the compact
 * Ledger has no home that preserves their structure, and the rich accounting
 * domain is the Phase 5 build. Replay populates them once it lands.
 *
 * Structured provider data writes provenance `extracted` (Phase 2 trust
 * mapping). Obligation idempotency rides the (counterparty, type, amount,
 * currency, due_date) dedup key; counterparties dedup on normalized name.
 */

import type { Pool } from "pg";
import { brainError, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import { upsertCounterpartyRow, upsertObligationRow } from "../service/writes.js";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

interface MergeInvoice {
  id?: string;
  remote_id?: string | null;
  type?: string;
  contact?: string | null;
  number?: string | null;
  issue_date?: string | null;
  due_date?: string | null;
  total_amount?: number | string | null;
  balance?: number | string | null;
  currency?: string | null;
  status?: string | null;
  line_items?: Array<{ account?: string | null; description?: string | null }>;
}

interface MergeContact {
  id?: string;
  remote_id?: string | null;
  name?: string | null;
  is_supplier?: boolean;
  is_customer?: boolean;
  email_address?: string | null;
}

const COUNTERPARTY_CONFIDENCE = 0.8;
const OBLIGATION_CONFIDENCE = 0.85;

/** Merge amounts arrive as JSON numbers or strings; normalize to an exact decimal string. */
export function mergeAmountToDecimal(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return null;
  // Reject float-exponent forms rather than guessing; Merge emits plain decimals.
  if (/[eE]/.test(s)) {
    throw brainError("ledger_row_invalid", `merge amount in exponent form: ${s}`);
  }
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [whole = "0", frac = ""] = body.split(".");
  const fixed = frac.length > 0 ? `${whole}.${frac.padEnd(2, "0")}` : `${whole}.00`;
  return negative ? `-${fixed}` : fixed;
}

function obligationStatus(invoice: MergeInvoice): "upcoming" | "due" | "paid" {
  if (invoice.status === "PAID") return "paid";
  if (invoice.due_date !== null && invoice.due_date !== undefined) {
    return "due";
  }
  return "upcoming";
}

export async function normalizeMergeAccountingArtifact(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  const objectType = input.payload["object_type"];
  const integration = input.payload["merge_integration"];
  const objects = input.payload["objects"];
  if (typeof objectType !== "string" || !Array.isArray(objects)) {
    throw brainError(
      "ledger_row_invalid",
      "merge_accounting_v1: payload must carry object_type + objects",
    );
  }
  const integrationName = typeof integration === "string" ? integration : null;

  const created: ExtractedRow[] = [];
  const common = {
    source_ids: [input.rawArtifactId],
    evidence_ids: [input.rawParsedId],
    provenance: "extracted",
  };

  for (const raw of objects) {
    if (objectType === "contact") {
      const contact = raw as MergeContact;
      if (typeof contact.id !== "string") continue;
      const name = contact.name ?? contact.email_address ?? contact.id;
      const type =
        contact.is_supplier === true
          ? "vendor"
          : contact.is_customer === true
            ? "customer"
            : "other";
      const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
        name,
        type,
        ...common,
        confidence: COUNTERPARTY_CONFIDENCE,
        metadata: {
          merge: {
            contact_id: contact.id,
            remote_id: contact.remote_id ?? null,
            integration: integrationName,
          },
        },
      });
      created.push({ entity: "counterparty", id: row.id });
      continue;
    }

    if (objectType === "invoice") {
      const invoice = raw as MergeInvoice;
      if (typeof invoice.id !== "string") continue;
      const isPayable = invoice.type === "ACCOUNTS_PAYABLE";
      const isReceivable = invoice.type === "ACCOUNTS_RECEIVABLE";
      if (!isPayable && !isReceivable) continue;

      // Outstanding balance when present; total otherwise. A fully paid bill
      // (balance 0) still lands, status paid, so history reconciles.
      const amount =
        mergeAmountToDecimal(invoice.balance) ?? mergeAmountToDecimal(invoice.total_amount);
      if (amount === null || amount.startsWith("-")) continue;
      const currency = (invoice.currency ?? "USD").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) continue;

      // The counterparty placeholder dedups against the richer contact row by
      // normalized name when names align; the Merge contact id in metadata is
      // the durable join key for Phase 4 resolution either way.
      const { row: cp } = await upsertCounterpartyRow(pool, audit, ctx, {
        name: invoice.contact ?? `merge:${invoice.id}`,
        type: isPayable ? "vendor" : "customer",
        ...common,
        confidence: COUNTERPARTY_CONFIDENCE,
        metadata: {
          merge: { contact_id: invoice.contact ?? null, integration: integrationName },
        },
      });
      created.push({ entity: "counterparty", id: cp.id });

      const glCodes = (invoice.line_items ?? [])
        .map((li) => li.account)
        .filter((a): a is string => typeof a === "string" && a.length > 0);

      const { row } = await upsertObligationRow(pool, audit, ctx, {
        type: isPayable ? "bill" : "invoice",
        counterparty_id: cp.id,
        amount_due: amount,
        currency,
        due_date: invoice.due_date ?? invoice.issue_date ?? new Date(0).toISOString(),
        status: obligationStatus(invoice),
        direction: isPayable ? "payable" : "receivable",
        ...common,
        confidence: OBLIGATION_CONFIDENCE,
        metadata: {
          merge: {
            invoice_id: invoice.id,
            remote_id: invoice.remote_id ?? null,
            integration: integrationName,
            number: invoice.number ?? null,
            gl_accounts: glCodes,
            line_items: invoice.line_items ?? [],
          },
        },
      });
      created.push({ entity: "obligation", id: row.id });
      continue;
    }

    // gl_account / journal_entry / payment / tax_rate: retained in raw_parsed,
    // promoted by the Phase 5 rich accounting domain (replay covers history).
  }

  return created;
}
