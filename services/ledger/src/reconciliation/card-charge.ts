/**
 * card_charge matcher.
 *
 * Pairs card_statement obligations with statement-payment outflow transactions:
 *   - obligation.type = 'card_statement' AND status IN (upcoming, due, overdue)
 *   - tx.direction = 'outflow' AND status IN (posted, cleared)
 *   - amount within ±2% (card payments round to minimum_due or full balance)
 *   - posted_date within ±5 days of obligation.due_date
 *
 * Card payments often land as the full-balance amount or the minimum_due. A
 * 2% tolerance covers minor interest accrual between statement cut and
 * payment posting. The ±5 day window handles bank processing delays.
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
  minimum_due: string | null;
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
const MAX_TX_PER_OBLIGATION = 15;
const SCAN_WINDOW_DAYS_DEFAULT = 60;
/** ±days window used by BOTH the SQL pre-filter and the scorer. Keep them in sync. */
export const DATE_WINDOW_DAYS = 5;

export class CardChargeMatcher implements Matcher {
  public readonly matchType = "card_charge" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const obligations = await loadCardStatements(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const obl of obligations) {
      if (matches.length >= input.maxMatches) break;

      const candidates = await loadCandidateTransactions(deps.pool, input.ctx, obl);
      let bestPair: { tx: TxCandidate; score: number } | null = null;

      for (const tx of candidates) {
        if (tx.currency !== obl.currency) continue;
        // Score against full amount_due and minimum_due; take the higher signal.
        const amtFull = amountScore(obl.amount_due, tx.amount);
        const amtMin = obl.minimum_due !== null ? amountScore(obl.minimum_due, tx.amount) : 0;
        const score = combine([
          { score: Math.max(amtFull, amtMin), weight: 0.6 },
          {
            score: dateScore(obl.due_date, tx.posted_date ?? tx.transaction_date, DATE_WINDOW_DAYS),
            weight: 0.4,
          },
        ]);
        if (score >= MATCH_THRESHOLD && (bestPair === null || score > bestPair.score)) {
          bestPair = { tx, score };
        }
      }

      if (bestPair !== null) {
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "card_charge",
          leftEntityType: "obligation",
          leftEntityId: obl.id,
          rightEntityType: "transaction",
          rightEntityId: bestPair.tx.id,
          confidenceScore: bestPair.score,
          evidenceIds: [],
          explanation:
            `card_charge: obligation ${obl.id} ${obl.amount_due} ${obl.currency} due ${obl.due_date.toISOString().slice(0, 10)} ` +
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

async function loadCardStatements(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<ObligationCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<ObligationCandidate>(
      `SELECT id, counterparty_id, amount_due::TEXT, minimum_due::TEXT, currency, due_date
         FROM ledger_obligations
        WHERE type = 'card_statement'
          AND status IN ('upcoming','due','overdue')
          AND due_date >= $1
          AND NOT EXISTS (
            SELECT 1 FROM ledger_reconciliation_matches
             WHERE match_type = 'card_charge'
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
    // DATE_WINDOW_DAYS is a trusted integer constant (not user input). Building
    // the interval from it keeps the SQL pre-filter in lockstep with the scorer;
    // hardcoding the literal here silently desyncs the two if the constant moves.
    const { rows } = await c.query<TxCandidate>(
      `SELECT id, counterparty_id, amount::TEXT, currency, transaction_date, posted_date
         FROM ledger_transactions
        WHERE direction = 'outflow'
          AND status IN ('posted','cleared')
          AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')
          AND transaction_date >= ($1::timestamptz - $3::interval)
          AND transaction_date <= ($1::timestamptz + $3::interval)
        ORDER BY ABS(EXTRACT(EPOCH FROM (transaction_date - $1::timestamptz))) ASC
        LIMIT $2`,
      [obl.due_date, MAX_TX_PER_OBLIGATION, `${DATE_WINDOW_DAYS} days`],
    );
    return rows;
  });
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
