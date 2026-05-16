/**
 * wallet_transfer matcher.
 *
 * Pairs on-chain outflow transactions with exchange/bank inflow transactions:
 *   - left side: outflow tx from an account with account_type = 'onchain'
 *   - right side: inflow tx on any account within ±10 min of the outflow
 *   - amount agreement (on-chain amounts are precise; zero tolerance beyond 0.1%)
 *
 * On-chain settlement is near-instant; the ±10 min window accommodates block
 * confirmation lag and indexer delays. The amount must be close to exact
 * because on-chain transfer amounts are deterministic.
 */

import { withTenantScope, type ServiceCallContext } from "@brain/api/shared";
import type { Pool } from "pg";
import { combine, amountScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface OnchainTx {
  id: string;
  account_id: string;
  amount: string;
  currency: string;
  transaction_date: Date;
}

interface InboundTx {
  id: string;
  account_id: string;
  amount: string;
  currency: string;
  transaction_date: Date;
}

const MATCH_THRESHOLD = 0.8;
const MAX_OUTFLOWS = 200;
const MAX_INBOUND_PER_OUTFLOW = 10;
const SCAN_WINDOW_DAYS_DEFAULT = 30;

export class WalletTransferMatcher implements Matcher {
  public readonly matchType = "wallet_transfer" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const outflows = await loadOnchainOutflows(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const out of outflows) {
      if (matches.length >= input.maxMatches) break;

      const inbounds = await loadNearbyInbounds(deps.pool, input.ctx, out);
      let bestPair: { tx: InboundTx; score: number } | null = null;

      for (const inb of inbounds) {
        if (inb.currency !== out.currency) continue;
        // Timestamp proximity: linear decay within 10-minute window.
        const diffMinutes =
          Math.abs(inb.transaction_date.getTime() - out.transaction_date.getTime()) / 60_000;
        const tScore = diffMinutes <= 1 ? 1 : diffMinutes <= 5 ? 0.9 : diffMinutes <= 10 ? 0.7 : 0;
        if (tScore === 0) continue;

        const score = combine([
          { score: amountScore(out.amount, inb.amount), weight: 0.7 },
          { score: tScore, weight: 0.3 },
        ]);
        if (score >= MATCH_THRESHOLD && (bestPair === null || score > bestPair.score)) {
          bestPair = { tx: inb, score };
        }
      }

      if (bestPair !== null) {
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "wallet_transfer",
          leftEntityType: "transaction",
          leftEntityId: out.id,
          rightEntityType: "transaction",
          rightEntityId: bestPair.tx.id,
          confidenceScore: bestPair.score,
          evidenceIds: [],
          explanation:
            `wallet_transfer: onchain outflow ${out.id} ${out.amount} ${out.currency} ` +
            `↔ inbound ${bestPair.tx.id} ${bestPair.tx.amount} ${bestPair.tx.currency} ` +
            `(score=${bestPair.score.toFixed(3)})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "transaction",
            leftEntityId: out.id,
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
      candidatesScanned: outflows.length,
    };
  }
}

async function loadOnchainOutflows(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<OnchainTx[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<OnchainTx>(
      `SELECT t.id, t.account_id, t.amount::TEXT, t.currency, t.transaction_date
         FROM ledger_transactions t
         JOIN ledger_accounts a ON a.id = t.account_id
        WHERE t.direction = 'outflow'
          AND t.status IN ('posted','cleared')
          AND (t.reconciliation_status IS NULL OR t.reconciliation_status = 'unreconciled')
          AND a.account_type = 'onchain'
          AND t.transaction_date >= $1
        ORDER BY t.transaction_date DESC
        LIMIT $2`,
      [since, MAX_OUTFLOWS],
    );
    return rows;
  });
}

async function loadNearbyInbounds(
  pool: Pool,
  ctx: ServiceCallContext,
  out: OnchainTx,
): Promise<InboundTx[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<InboundTx>(
      `SELECT id, account_id, amount::TEXT, currency, transaction_date
         FROM ledger_transactions
        WHERE direction = 'inflow'
          AND status IN ('posted','cleared')
          AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')
          AND id <> $1
          AND transaction_date >= ($2::timestamptz - INTERVAL '10 minutes')
          AND transaction_date <= ($2::timestamptz + INTERVAL '10 minutes')
        ORDER BY ABS(EXTRACT(EPOCH FROM (transaction_date - $2::timestamptz))) ASC
        LIMIT $3`,
      [out.id, out.transaction_date, MAX_INBOUND_PER_OUTFLOW],
    );
    return rows;
  });
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
