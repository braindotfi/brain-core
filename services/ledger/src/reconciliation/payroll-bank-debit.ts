/**
 * payroll_bank_debit matcher.
 *
 * Pairs payroll obligations with outflow transactions:
 *   - obligation.type = 'payroll' AND status IN (upcoming, due, overdue)
 *   - tx.direction = 'outflow' AND status IN (posted, cleared)
 *   - amount within ±0.5% of obligation.amount_due (small rounding allowed)
 *   - posted_date within ±3 days of obligation.due_date
 *   - same counterparty preferred (weight 0.15)
 *
 * Payroll processors sometimes batch or round individual disbursements, so
 * a 0.5% tolerance handles minor rounding without matching wrong rows.
 */

import { withTenantScope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { combine, amountScore, dateScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface ObligationCandidate {
  id: string;
  counterparty_id: string;
  amount_due: string;
  currency: string;
  due_date: Date;
}

interface TxCandidate {
  id: string;
  counterparty_id: string | null;
  amount: string;
  currency: string;
  transaction_date: Date;
  posted_date: Date | null;
}

const MATCH_THRESHOLD = 0.7;
const MAX_OBLIGATIONS = 100;
const MAX_TX_PER_OBLIGATION = 20;
const SCAN_WINDOW_DAYS_DEFAULT = 60;
const DATE_WINDOW_DAYS = 3;

export class PayrollBankDebitMatcher implements Matcher {
  public readonly matchType = "payroll_bank_debit" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const obligations = await loadPayrollObligations(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const obl of obligations) {
      if (matches.length >= input.maxMatches) break;

      const candidates = await loadCandidateTransactions(deps.pool, input.ctx, obl);
      let bestPair: { tx: TxCandidate; score: number } | null = null;

      for (const tx of candidates) {
        if (tx.currency !== obl.currency) continue;
        const score = combine([
          { score: amountScore(obl.amount_due, tx.amount), weight: 0.6 },
          {
            score: dateScore(obl.due_date, tx.posted_date ?? tx.transaction_date, DATE_WINDOW_DAYS),
            weight: 0.25,
          },
          { score: tx.counterparty_id === obl.counterparty_id ? 1 : 0, weight: 0.15 },
        ]);
        if (score >= MATCH_THRESHOLD && (bestPair === null || score > bestPair.score)) {
          bestPair = { tx, score };
        }
      }

      if (bestPair !== null) {
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "payroll_bank_debit",
          leftEntityType: "obligation",
          leftEntityId: obl.id,
          rightEntityType: "transaction",
          rightEntityId: bestPair.tx.id,
          confidenceScore: bestPair.score,
          evidenceIds: [],
          explanation:
            `payroll_bank_debit: obligation ${obl.id} ${obl.amount_due} ${obl.currency} due ${obl.due_date.toISOString().slice(0, 10)} ` +
            `→ tx ${bestPair.tx.id} ${bestPair.tx.amount} ${bestPair.tx.currency} ` +
            `(score=${bestPair.score.toFixed(3)})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "obligation",
            leftEntityId: obl.id,
            rightEntityType: "transaction",
            rightEntityId: bestPair.tx.id,
            confidenceScore: bestPair.score,
          });
        }
      }
    }

    return {
      matchType: this.matchType,
      matchesProduced: matches,
      candidatesScanned: obligations.length,
    };
  }
}

async function loadPayrollObligations(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<ObligationCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<ObligationCandidate>(
      `SELECT id, counterparty_id, amount_due::TEXT, currency, due_date
         FROM ledger_obligations
        WHERE type = 'payroll'
          AND status IN ('upcoming','due','overdue')
          AND due_date >= $1
          AND NOT EXISTS (
            SELECT 1 FROM ledger_reconciliation_matches
             WHERE match_type = 'payroll_bank_debit'
               AND left_entity_type = 'obligation'
               AND left_entity_id = ledger_obligations.id
          )
        ORDER BY due_date ASC
        LIMIT $2`,
      [since, MAX_OBLIGATIONS],
    );
    return rows;
  });
}

async function loadCandidateTransactions(
  pool: Pool,
  ctx: ServiceCallContext,
  obl: ObligationCandidate,
): Promise<TxCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<TxCandidate>(
      `SELECT id, counterparty_id, amount::TEXT, currency, transaction_date, posted_date
         FROM ledger_transactions
        WHERE direction = 'outflow'
          AND status IN ('posted','cleared')
          AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')
          AND transaction_date >= ($1::timestamptz - INTERVAL '3 days')
          AND transaction_date <= ($1::timestamptz + INTERVAL '3 days')
        ORDER BY ABS(EXTRACT(EPOCH FROM (transaction_date - $1::timestamptz))) ASC
        LIMIT $2`,
      [obl.due_date, MAX_TX_PER_OBLIGATION],
    );
    return rows;
  });
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
