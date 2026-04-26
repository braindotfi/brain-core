/**
 * transaction_receipt matcher.
 *
 * Pairs ledger_transactions with ledger_documents(receipt):
 *   - amount agreement (extracted_fields.amount vs tx.amount)
 *   - date proximity (extracted_fields.date vs tx.transaction_date)
 *   - merchant / counterparty name overlap
 *
 * The receipt's structured fields are populated by the document parser
 * pipeline (Phase 3+ extractors). When the parser couldn't extract an
 * amount/date the matcher skips the candidate rather than guessing.
 */

import {
  withTenantScope,
  type ServiceCallContext,
} from "@brain/api/shared";
import type { Pool } from "pg";
import { combine, amountScore, dateScore, nameScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface DocumentCandidate {
  id: string;
  extracted_fields: {
    amount?: string | number;
    currency?: string;
    date?: string;
    merchant_name?: string;
  };
  linked_account_ids: string[];
}

interface TxCandidate {
  id: string;
  account_id: string;
  amount: string;
  currency: string;
  transaction_date: Date;
  posted_date: Date | null;
  description_normalized: string | null;
  description_raw: string | null;
}

const MATCH_THRESHOLD = 0.65;
const MAX_DOCUMENTS = 200;
const MAX_TX_CANDIDATES_PER_DOC = 20;
const SCAN_WINDOW_DAYS_DEFAULT = 60;

export class TransactionReceiptMatcher implements Matcher {
  public readonly matchType = "transaction_receipt" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);

    const docs = await loadCandidateDocuments(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const doc of docs) {
      if (matches.length >= input.maxMatches) break;
      const fields = doc.extracted_fields ?? {};
      const docAmount = decimalString(fields.amount);
      const docCurrency = (fields.currency ?? "USD").toUpperCase();
      const docDateStr = typeof fields.date === "string" ? fields.date : null;
      if (docAmount === null || docDateStr === null) continue;
      const docDate = new Date(docDateStr);
      if (Number.isNaN(docDate.getTime())) continue;

      const txCandidates = await loadCandidateTransactions(
        deps.pool,
        input.ctx,
        docDate,
        doc.linked_account_ids,
      );

      let bestPair: { tx: TxCandidate; score: number } | null = null;
      for (const tx of txCandidates) {
        if (tx.currency !== docCurrency) continue;
        const merchant = fields.merchant_name ?? null;
        const txMemo = tx.description_normalized ?? tx.description_raw ?? null;
        const score = combine([
          { score: amountScore(docAmount, tx.amount), weight: 0.55 },
          { score: dateScore(docDate, tx.posted_date ?? tx.transaction_date, 7), weight: 0.30 },
          { score: nameScore(merchant, txMemo), weight: 0.15 },
        ]);
        if (score >= MATCH_THRESHOLD && (bestPair === null || score > bestPair.score)) {
          bestPair = { tx, score };
        }
      }

      if (bestPair !== null) {
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "transaction_receipt",
          leftEntityType: "transaction",
          leftEntityId: bestPair.tx.id,
          rightEntityType: "document",
          rightEntityId: doc.id,
          confidenceScore: bestPair.score,
          evidenceIds: [],
          explanation:
            `transaction_receipt: tx ${bestPair.tx.id} ${bestPair.tx.amount} ${bestPair.tx.currency} ` +
            `↔ doc ${doc.id} (score=${bestPair.score.toFixed(3)})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "transaction",
            leftEntityId: bestPair.tx.id,
            rightEntityType: "document",
            rightEntityId: doc.id,
            confidenceScore: bestPair.score,
          });
        }
      }
    }

    return {
      matchType: this.matchType,
      matchesProduced: matches,
      candidatesScanned: docs.length,
    };
  }
}

// ---------- Queries -------------------------------------------------------

async function loadCandidateDocuments(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<DocumentCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<DocumentCandidate>(
      `SELECT id, extracted_fields, linked_account_ids
         FROM ledger_documents
        WHERE document_type = 'receipt'
          AND created_at >= $1
          AND NOT EXISTS (
            SELECT 1 FROM ledger_reconciliation_matches
             WHERE match_type = 'transaction_receipt'
               AND right_entity_type = 'document'
               AND right_entity_id = ledger_documents.id
          )
        ORDER BY created_at DESC
        LIMIT $2`,
      [since, MAX_DOCUMENTS],
    );
    return rows;
  });
}

async function loadCandidateTransactions(
  pool: Pool,
  ctx: ServiceCallContext,
  near: Date,
  linkedAccountIds: ReadonlyArray<string>,
): Promise<TxCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const accountFilter =
      linkedAccountIds.length === 0
        ? ""
        : `AND account_id = ANY($3::TEXT[])`;
    const values: unknown[] = [near, MAX_TX_CANDIDATES_PER_DOC];
    if (linkedAccountIds.length > 0) values.push(Array.from(linkedAccountIds));
    const { rows } = await c.query<TxCandidate>(
      `SELECT id, account_id, amount, currency, transaction_date,
              posted_date, description_normalized, description_raw
         FROM ledger_transactions
        WHERE status IN ('posted','cleared')
          AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')
          AND transaction_date >= ($1::timestamptz - INTERVAL '7 days')
          AND transaction_date <= ($1::timestamptz + INTERVAL '7 days')
          ${accountFilter}
        ORDER BY transaction_date ASC
        LIMIT $2`,
      values,
    );
    return rows;
  });
}

function decimalString(v: string | number | undefined): string | null {
  if (v === undefined) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v.toFixed(2);
  }
  return /^-?\d+(\.\d+)?$/.test(v) ? v : null;
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
