/**
 * statement_balance matcher.
 *
 * Pairs ledger_documents(bank_statement) with ledger_balances:
 *   - same account (via document.linked_account_ids)
 *   - extracted_fields.balance vs ledger_balance.current_balance
 *   - as_of date proximity ±3 days
 *
 * Documents without a parseable balance or date are skipped rather than
 * guessed at. A document may link multiple accounts; the best-scoring
 * (document, balance) pair across all linked accounts wins.
 */

import { withTenantScope, type ServiceCallContext } from "@brain/api/shared";
import type { Pool } from "pg";
import { combine, amountScore, dateScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface StatementCandidate {
  id: string;
  linked_account_ids: string[];
  extracted_fields: {
    balance?: string | number;
    available_balance?: string | number;
    currency?: string;
    statement_date?: string;
    as_of?: string;
  };
  created_at: Date;
}

interface BalanceCandidate {
  id: string;
  account_id: string;
  current_balance: string;
  currency: string;
  as_of: Date;
}

const MATCH_THRESHOLD = 0.75;
const MAX_STATEMENTS = 100;
const MAX_BALANCES_PER_STATEMENT = 10;
const SCAN_WINDOW_DAYS_DEFAULT = 90;
const DATE_WINDOW_DAYS = 3;

export class StatementBalanceMatcher implements Matcher {
  public readonly matchType = "statement_balance" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const docs = await loadBankStatements(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const doc of docs) {
      if (matches.length >= input.maxMatches) break;

      const fields = doc.extracted_fields ?? {};
      const docBalance = decimalString(fields.balance);
      const docDateStr =
        typeof fields.statement_date === "string"
          ? fields.statement_date
          : typeof fields.as_of === "string"
            ? fields.as_of
            : null;
      if (docBalance === null || docDateStr === null) continue;
      const docDate = new Date(docDateStr);
      if (Number.isNaN(docDate.getTime())) continue;
      if (doc.linked_account_ids.length === 0) continue;

      const docCurrency = (
        typeof fields.currency === "string" ? fields.currency : "USD"
      ).toUpperCase();
      const balances = await loadNearbyBalances(
        deps.pool,
        input.ctx,
        docDate,
        doc.linked_account_ids,
      );

      let bestPair: { balance: BalanceCandidate; score: number } | null = null;
      for (const bal of balances) {
        if (bal.currency !== docCurrency) continue;
        const score = combine([
          { score: amountScore(docBalance, bal.current_balance), weight: 0.65 },
          { score: dateScore(docDate, bal.as_of, DATE_WINDOW_DAYS), weight: 0.35 },
        ]);
        if (score >= MATCH_THRESHOLD && (bestPair === null || score > bestPair.score)) {
          bestPair = { balance: bal, score };
        }
      }

      if (bestPair !== null) {
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "statement_balance",
          leftEntityType: "document",
          leftEntityId: doc.id,
          rightEntityType: "balance",
          rightEntityId: bestPair.balance.id,
          confidenceScore: bestPair.score,
          evidenceIds: [],
          explanation:
            `statement_balance: doc ${doc.id} balance ${docBalance} ${docCurrency} ` +
            `→ ledger_balance ${bestPair.balance.id} ${bestPair.balance.current_balance} ` +
            `(score=${bestPair.score.toFixed(3)})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "document",
            leftEntityId: doc.id,
            rightEntityType: "balance",
            rightEntityId: bestPair.balance.id,
            confidenceScore: bestPair.score,
          });
        }
      }
    }

    return { matchType: this.matchType, matchesProduced: matches, candidatesScanned: docs.length };
  }
}

async function loadBankStatements(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<StatementCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<StatementCandidate>(
      `SELECT id, linked_account_ids, extracted_fields, created_at
         FROM ledger_documents
        WHERE document_type = 'bank_statement'
          AND created_at >= $1
          AND NOT EXISTS (
            SELECT 1 FROM ledger_reconciliation_matches
             WHERE match_type = 'statement_balance'
               AND left_entity_type = 'document'
               AND left_entity_id = ledger_documents.id
          )
        ORDER BY created_at DESC
        LIMIT $2`,
      [since, MAX_STATEMENTS],
    );
    return rows;
  });
}

async function loadNearbyBalances(
  pool: Pool,
  ctx: ServiceCallContext,
  near: Date,
  accountIds: ReadonlyArray<string>,
): Promise<BalanceCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<BalanceCandidate>(
      `SELECT id, account_id, current_balance::TEXT, currency, as_of
         FROM ledger_balances
        WHERE account_id = ANY($1::TEXT[])
          AND as_of >= ($2::timestamptz - INTERVAL '3 days')
          AND as_of <= ($2::timestamptz + INTERVAL '3 days')
        ORDER BY ABS(EXTRACT(EPOCH FROM (as_of - $2::timestamptz))) ASC
        LIMIT $3`,
      [Array.from(accountIds), near, MAX_BALANCES_PER_STATEMENT],
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
