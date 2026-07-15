/**
 * Finch payroll extractor — interprets `finch_payroll_v1` raw_parsed rows
 * (Phase 3 connector 4, Appendix A).
 *
 * Payload shape (produced by the raw interpretation worker):
 * { object_type, objects }.
 *
 * Canonical mapping per the spec:
 *  - individual (directory row) -> counterparty type employee, PII-tagged
 *    (metadata.pii = true). Only name + department reach the Ledger; the
 *    client never pulls SSN/dob, and pay-statement compensation detail stays
 *    encrypted in the raw blob store (never promoted to raw_parsed).
 *  - pay_run, past pay date    -> net-pay outflow transaction on a
 *    "Payroll (Finch)" payment_processor account, idempotent by payment id
 *  - pay_run, future pay date  -> payroll obligation (the upcoming run as a
 *    liability), direction payable, due at the pay date
 *
 * Aggregate amounts only (gross/net/company debit) land in metadata.finch —
 * never per-individual compensation. Structured provider data writes
 * provenance `extracted` (Phase 2 trust mapping). Finch money fields are
 * integer cents; conversion shares the exact-decimal helper with the Stripe
 * extractor.
 */

import type { Pool } from "pg";
import { brainError, type AuditEmitter, type ServiceCallContext } from "@brain/shared";
import {
  recordTransactionRow,
  upsertAccountRow,
  upsertCounterpartyRow,
  upsertObligationRow,
} from "../service/writes.js";
import { centsToDecimal } from "./stripe.js";
import type { ExtractedRow, ParserExtractInput } from "./registry.js";

interface FinchIndividual {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  department?: { name?: string | null } | null;
  is_active?: boolean;
}

interface FinchPayRun {
  id?: string;
  pay_date?: string | null;
  debit_date?: string | null;
  company_debit?: { amount?: number } | null;
  gross_pay?: { amount?: number } | null;
  net_pay?: { amount?: number } | null;
  individual_ids?: string[];
}

const ACCOUNT_CONFIDENCE = 0.95;
const TRANSACTION_CONFIDENCE = 0.9;
const COUNTERPARTY_CONFIDENCE = 0.8;
const OBLIGATION_CONFIDENCE = 0.85;

function payRunAmountCents(run: FinchPayRun): number | null {
  const v = run.company_debit?.amount ?? run.net_pay?.amount ?? null;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export async function normalizeFinchArtifact(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  input: ParserExtractInput,
): Promise<ExtractedRow[]> {
  const objectType = input.payload["object_type"];
  const objects = input.payload["objects"];
  if (typeof objectType !== "string" || !Array.isArray(objects)) {
    throw brainError(
      "ledger_row_invalid",
      "finch_payroll_v1: payload must carry object_type + objects",
    );
  }

  const created: ExtractedRow[] = [];
  const common = {
    source_ids: [input.rawArtifactId],
    evidence_ids: [input.rawParsedId],
    provenance: "extracted",
  };

  if (objectType === "individual") {
    for (const raw of objects) {
      const ind = raw as FinchIndividual;
      if (typeof ind.id !== "string") continue;
      const name = [ind.first_name, ind.last_name].filter(Boolean).join(" ") || ind.id;
      try {
        const { row } = await upsertCounterpartyRow(pool, audit, ctx, {
          name,
          type: "employee",
          ...common,
          confidence: COUNTERPARTY_CONFIDENCE,
          metadata: {
            // PII tag: downstream surfaces (Wiki projection, agent traces,
            // model prompts) filter on this flag.
            pii: true,
            finch: {
              individual_id: ind.id,
              department: ind.department?.name ?? null,
              is_active: ind.is_active ?? null,
            },
          },
        });
        created.push({ entity: "counterparty", id: row.id });
      } catch {
        continue;
      }
    }
    return created;
  }

  if (objectType === "pay_run") {
    const { row: account } = await upsertAccountRow(pool, audit, ctx, {
      external_account_id: "finch_payroll",
      institution: "Finch",
      account_type: "payment_processor",
      name: "Payroll (Finch)",
      currency: "USD",
      status: "active",
      ...common,
      confidence: ACCOUNT_CONFIDENCE,
    });
    created.push({ entity: "account", id: account.id });

    // The liability party for upcoming runs: the payroll obligation is owed
    // to the workforce through the processor; per-employee attribution stays
    // in the (raw-only) pay statements.
    let processorCpId: string | null = null;

    const now = Date.now();
    for (const raw of objects) {
      const run = raw as FinchPayRun;
      if (typeof run.id !== "string") continue;
      const cents = payRunAmountCents(run);
      if (cents === null || cents < 0) continue;
      const payDate = run.pay_date ?? run.debit_date;
      if (typeof payDate !== "string" || Number.isNaN(new Date(payDate).getTime())) continue;
      const aggregates = {
        payment_id: run.id,
        gross_pay_cents: run.gross_pay?.amount ?? null,
        net_pay_cents: run.net_pay?.amount ?? null,
        individual_count: run.individual_ids?.length ?? null,
      };

      try {
        if (new Date(payDate).getTime() <= now) {
          const { row } = await recordTransactionRow(pool, audit, ctx, {
            account_id: account.id,
            external_transaction_id: run.id,
            amount: centsToDecimal(cents),
            currency: "USD",
            direction: "outflow",
            transaction_date: new Date(payDate).toISOString(),
            status: "posted",
            description_raw: "Payroll run",
            ...common,
            confidence: TRANSACTION_CONFIDENCE,
          });
          created.push({ entity: "transaction", id: row.id });
          continue;
        }

        if (processorCpId === null) {
          const { row: cp } = await upsertCounterpartyRow(pool, audit, ctx, {
            name: "Payroll (Finch)",
            type: "other",
            ...common,
            confidence: COUNTERPARTY_CONFIDENCE,
          });
          processorCpId = cp.id;
          created.push({ entity: "counterparty", id: cp.id });
        }
        const { row } = await upsertObligationRow(pool, audit, ctx, {
          type: "payroll",
          counterparty_id: processorCpId,
          amount_due: centsToDecimal(cents),
          currency: "USD",
          due_date: new Date(payDate).toISOString(),
          status: "upcoming",
          direction: "payable",
          ...common,
          confidence: OBLIGATION_CONFIDENCE,
          metadata: { finch: aggregates },
        });
        created.push({ entity: "obligation", id: row.id });
      } catch {
        continue;
      }
    }
    return created;
  }

  // Other object types stay retained in raw (pay statements never even reach
  // raw_parsed — PII minimization).
  return created;
}
