/**
 * onchain_settlement matcher.
 *
 * Confirms an on-chain settlement outflow — a payment Brain dispatched from an
 * on-chain account (e.g. a USDC transfer on Base) — against the obligation it
 * settles:
 *   - left side:  outflow tx from an account with account_type = 'onchain',
 *                 status posted/cleared, still unreconciled
 *   - right side: an open/due/overdue obligation for the SAME counterparty
 *   - amount near-exact (on-chain amounts are deterministic) + counterparty
 *     agreement + due-date proximity
 *
 * This is the settlement-proof half of the M2M / x402 path (RFC 0001): every
 * on-chain payment is reconciled back to the obligation it discharges.
 * Deterministic — no LLM, no Wiki text — and idempotent (persistMatch dedups).
 */

import { withTenantScope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { combine, amountScore, dateScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface SettlementTx {
  id: string;
  counterparty_id: string | null;
  amount: string;
  currency: string;
  transaction_date: Date;
}

interface ObligationCandidate {
  id: string;
  counterparty_id: string;
  amount_due: string;
  currency: string;
  due_date: Date;
}

const MATCH_THRESHOLD = 0.8;
const MAX_SETTLEMENTS = 200;
const MAX_OBLIGATIONS_PER_TX = 10;
const SCAN_WINDOW_DAYS_DEFAULT = 30;
const DATE_WINDOW_DAYS = 5;
const OBLIGATION_LOOKBACK_DAYS = 30;

export class OnchainSettlementMatcher implements Matcher {
  public readonly matchType = "onchain_settlement" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const settlements = await loadOnchainSettlements(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const stl of settlements) {
      if (matches.length >= input.maxMatches) break;
      if (stl.counterparty_id === null) continue; // cannot correlate without a payee

      const obligations = await loadCandidateObligations(deps.pool, input.ctx, stl);
      let bestPair: { obl: ObligationCandidate; score: number } | null = null;

      for (const obl of obligations) {
        if (obl.currency !== stl.currency) continue;
        const score = combine([
          { score: amountScore(stl.amount, obl.amount_due), weight: 0.6 },
          { score: obl.counterparty_id === stl.counterparty_id ? 1 : 0, weight: 0.2 },
          { score: dateScore(obl.due_date, stl.transaction_date, DATE_WINDOW_DAYS), weight: 0.2 },
        ]);
        if (score >= MATCH_THRESHOLD && (bestPair === null || score > bestPair.score)) {
          bestPair = { obl, score };
        }
      }

      if (bestPair !== null) {
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "onchain_settlement",
          leftEntityType: "transaction",
          leftEntityId: stl.id,
          rightEntityType: "obligation",
          rightEntityId: bestPair.obl.id,
          confidenceScore: bestPair.score,
          evidenceIds: [],
          explanation:
            `onchain_settlement: tx ${stl.id} ${stl.amount} ${stl.currency} ` +
            `↔ obligation ${bestPair.obl.id} ${bestPair.obl.amount_due} ${bestPair.obl.currency} ` +
            `(score=${bestPair.score.toFixed(3)})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "transaction",
            leftEntityId: stl.id,
            rightEntityType: "obligation",
            rightEntityId: bestPair.obl.id,
            confidenceScore: bestPair.score,
          });
        }
      }
    }

    return {
      matchType: this.matchType,
      matchesProduced: matches,
      candidatesScanned: settlements.length,
    };
  }
}

async function loadOnchainSettlements(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<SettlementTx[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<SettlementTx>(
      `SELECT t.id, t.counterparty_id, t.amount::TEXT, t.currency, t.transaction_date
         FROM ledger_transactions t
         JOIN ledger_accounts a ON a.id = t.account_id
        WHERE t.direction = 'outflow'
          AND t.status IN ('posted','cleared')
          AND (t.reconciliation_status IS NULL OR t.reconciliation_status = 'unreconciled')
          AND a.account_type = 'onchain'
          AND t.transaction_date >= $1
        ORDER BY t.transaction_date DESC
        LIMIT $2`,
      [since, MAX_SETTLEMENTS],
    );
    return rows;
  });
}

async function loadCandidateObligations(
  pool: Pool,
  ctx: ServiceCallContext,
  stl: SettlementTx,
): Promise<ObligationCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<ObligationCandidate>(
      `SELECT id, counterparty_id, amount_due::TEXT, currency, due_date
         FROM ledger_obligations
        WHERE status IN ('upcoming','due','overdue')
          AND counterparty_id = $1
          AND due_date >= ($2::timestamptz - INTERVAL '${OBLIGATION_LOOKBACK_DAYS} days')
        ORDER BY due_date ASC
        LIMIT $3`,
      [stl.counterparty_id, stl.transaction_date, MAX_OBLIGATIONS_PER_TX],
    );
    return rows;
  });
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
