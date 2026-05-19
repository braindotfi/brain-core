/**
 * invoice_payment matcher.
 *
 * Pairs ledger_invoices with ledger_transactions:
 *   - same counterparty
 *   - amount agreement (1.0 == identical, 0.95 within 0.1%, 0.6 within 1%, …)
 *   - posted_date proximity to issue_date / due_date (±7 days)
 *
 * Only outflow transactions can settle a payable invoice; inflow
 * transactions can settle a receivable invoice. We use the invoice's
 * status + counterparty.type heuristic: invoices with status `partial`
 * remain candidates after a partial match.
 */

import { withTenantScope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { combine, amountScore, dateScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface InvoiceCandidate {
  id: string;
  counterparty_id: string;
  amount_due: string;
  amount_paid: string;
  currency: string;
  issue_date: Date;
  due_date: Date | null;
  status: string;
}

interface TransactionCandidate {
  id: string;
  counterparty_id: string | null;
  amount: string;
  currency: string;
  direction: string;
  transaction_date: Date;
  posted_date: Date | null;
  reconciliation_status: string | null;
}

const MATCH_THRESHOLD = 0.7;
const MAX_INVOICE_CANDIDATES = 100;
const MAX_TX_CANDIDATES_PER_INVOICE = 25;
const SCAN_WINDOW_DAYS_DEFAULT = 30;

export class InvoicePaymentMatcher implements Matcher {
  public readonly matchType = "invoice_payment" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);

    const matches: MatcherResult["matchesProduced"] = [];
    let scanned = 0;

    const invoices = await loadOpenInvoices(deps.pool, input.ctx, since);
    scanned = invoices.length;

    for (const inv of invoices) {
      if (matches.length >= input.maxMatches) break;
      const candidates = await loadCandidateTransactions(deps.pool, input.ctx, inv);
      let bestPair: { tx: TransactionCandidate; score: number } | null = null;

      for (const tx of candidates) {
        if (tx.currency !== inv.currency) continue;
        const score = combine([
          { score: amountScore(inv.amount_due, tx.amount), weight: 0.55 },
          {
            score: dateScore(
              inv.due_date ?? inv.issue_date,
              tx.posted_date ?? tx.transaction_date,
              14,
            ),
            weight: 0.3,
          },
          { score: tx.counterparty_id === inv.counterparty_id ? 1 : 0, weight: 0.15 },
        ]);
        if (score >= MATCH_THRESHOLD && (bestPair === null || score > bestPair.score)) {
          bestPair = { tx, score };
        }
      }

      if (bestPair !== null) {
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "invoice_payment",
          leftEntityType: "invoice",
          leftEntityId: inv.id,
          rightEntityType: "transaction",
          rightEntityId: bestPair.tx.id,
          confidenceScore: bestPair.score,
          evidenceIds: [],
          explanation:
            `invoice_payment: invoice ${inv.id} amount ${inv.amount_due} ${inv.currency} ` +
            `→ tx ${bestPair.tx.id} amount ${bestPair.tx.amount} ${bestPair.tx.currency} ` +
            `(score=${bestPair.score.toFixed(3)})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "invoice",
            leftEntityId: inv.id,
            rightEntityType: "transaction",
            rightEntityId: bestPair.tx.id,
            confidenceScore: bestPair.score,
          });
        }
      }
    }

    return { matchType: this.matchType, matchesProduced: matches, candidatesScanned: scanned };
  }
}

// ---------- Queries -------------------------------------------------------

async function loadOpenInvoices(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<InvoiceCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<InvoiceCandidate>(
      `SELECT id, counterparty_id, amount_due, amount_paid, currency,
              issue_date, due_date, status
         FROM ledger_invoices
        WHERE status IN ('sent','partial','overdue')
          AND issue_date >= $1
        ORDER BY issue_date DESC
        LIMIT $2`,
      [since, MAX_INVOICE_CANDIDATES],
    );
    return rows;
  });
}

async function loadCandidateTransactions(
  pool: Pool,
  ctx: ServiceCallContext,
  inv: InvoiceCandidate,
): Promise<TransactionCandidate[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<TransactionCandidate>(
      `SELECT id, counterparty_id, amount, currency, direction,
              transaction_date, posted_date, reconciliation_status
         FROM ledger_transactions
        WHERE status IN ('posted','cleared')
          AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')
          AND counterparty_id = $1
          AND transaction_date >= ($2::timestamptz - INTERVAL '14 days')
          AND transaction_date <= ($2::timestamptz + INTERVAL '30 days')
        ORDER BY transaction_date ASC
        LIMIT $3`,
      [inv.counterparty_id, inv.due_date ?? inv.issue_date, MAX_TX_CANDIDATES_PER_INVOICE],
    );
    return rows;
  });
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
