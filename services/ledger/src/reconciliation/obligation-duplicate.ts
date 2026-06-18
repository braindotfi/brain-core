/**
 * obligation_duplicate matcher (ingestion architecture Phase 4, §13).
 *
 * Pairs two OBSERVATIONS of the same real-world payable from different
 * sources — the document tier's extracted invoice vs the accounting
 * aggregator's open bill:
 *   - LEFT: low-trust obligations (provenance agent_contributed or
 *     customer_asserted), status upcoming/due/overdue
 *   - RIGHT: independent obligations (provenance extracted/human_confirmed),
 *     same counterparty, same currency, same direction, different row
 *   - amount exact-or-near (65%), due_date within ±7 days (35%)
 *
 * Resolution semantics (§11 "Resolved", §13): observations are LINKED, never
 * destructively merged. A score >= 0.8 records a confident `matched` row and
 * fires the corroboration lift on the low-trust side; 0.55..0.8 records a
 * `duplicate_possible` CANDIDATE that promotes nothing until a human
 * confirms it via ReconciliationService.setStatus — material ambiguity
 * defers to user review, and a rejected candidate is fully reversible.
 */

import { withTenantScope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { combine, amountScore, dateScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface ObligationObservation {
  id: string;
  counterparty_id: string;
  amount_due: string;
  currency: string;
  due_date: Date;
  direction: string | null;
}

const CONFIDENT_THRESHOLD = 0.8;
const CANDIDATE_THRESHOLD = 0.55;
const MAX_LEFT = 100;
const MAX_RIGHT_PER_LEFT = 10;
const SCAN_WINDOW_DAYS_DEFAULT = 60;
const DATE_WINDOW_DAYS = 7;

export class ObligationDuplicateMatcher implements Matcher {
  public readonly matchType = "obligation_duplicate" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const lowTrust = await loadLowTrustObligations(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const left of lowTrust) {
      if (matches.length >= input.maxMatches) break;

      const candidates = await loadIndependentObservations(deps.pool, input.ctx, left);
      let best: { right: ObligationObservation; score: number } | null = null;
      for (const right of candidates) {
        const score = combine([
          { score: amountScore(left.amount_due, right.amount_due), weight: 0.65 },
          { score: dateScore(left.due_date, right.due_date, DATE_WINDOW_DAYS), weight: 0.35 },
        ]);
        if (score >= CANDIDATE_THRESHOLD && (best === null || score > best.score)) {
          best = { right, score };
        }
      }

      if (best !== null) {
        const status = best.score >= CONFIDENT_THRESHOLD ? "matched" : "duplicate_possible";
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "obligation_duplicate",
          leftEntityType: "obligation",
          leftEntityId: left.id,
          rightEntityType: "obligation",
          rightEntityId: best.right.id,
          confidenceScore: best.score,
          evidenceIds: [],
          status,
          explanation:
            `obligation_duplicate: low-trust ${left.id} ${left.amount_due} ${left.currency} ` +
            `due ${left.due_date.toISOString().slice(0, 10)} ↔ independent ${best.right.id} ` +
            `${best.right.amount_due} due ${best.right.due_date.toISOString().slice(0, 10)} ` +
            `(score=${best.score.toFixed(3)}, ${status})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "obligation",
            leftEntityId: left.id,
            rightEntityType: "obligation",
            rightEntityId: best.right.id,
            confidenceScore: best.score,
          });
        }
      }
    }

    return {
      matchType: this.matchType,
      matchesProduced: matches,
      candidatesScanned: lowTrust.length,
    };
  }
}

async function loadLowTrustObligations(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<ObligationObservation[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<ObligationObservation>(
      `SELECT id, counterparty_id, amount_due::TEXT, currency, due_date, direction
         FROM ledger_obligations
        WHERE provenance IN ('agent_contributed','customer_asserted')
          AND status IN ('upcoming','due','overdue')
          AND due_date >= $1
          AND NOT EXISTS (
            SELECT 1 FROM ledger_reconciliation_matches m
             WHERE m.match_type = 'obligation_duplicate'
               AND m.left_entity_type = 'obligation'
               AND m.left_entity_id = ledger_obligations.id
               AND m.status IN ('matched','duplicate_possible')
          )
        ORDER BY due_date ASC
        LIMIT $2`,
      [since, MAX_LEFT],
    );
    return rows;
  });
}

async function loadIndependentObservations(
  pool: Pool,
  ctx: ServiceCallContext,
  left: ObligationObservation,
): Promise<ObligationObservation[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<ObligationObservation>(
      // Candidate counterparties: the left's own counterparty OR any
      // counterparty linked to it by a confirmed counterparty_duplicate match
      // (1 hop). Under canonical projection, observations of one vendor from
      // different sources are DISTINCT counterparty rows (link, don't merge), so
      // matching by a literal counterparty_id would miss cross-source payables;
      // we match across the resolved counterparty set instead. Requires
      // counterparty_duplicate to have run first (the reconciliation order).
      `SELECT id, counterparty_id, amount_due::TEXT, currency, due_date, direction
         FROM ledger_obligations
        WHERE provenance IN ('extracted','human_confirmed')
          AND id <> $1
          AND counterparty_id IN (
            SELECT $2::text
            UNION
            SELECT CASE WHEN m.left_entity_id = $2 THEN m.right_entity_id ELSE m.left_entity_id END
              FROM ledger_reconciliation_matches m
             WHERE m.match_type = 'counterparty_duplicate'
               AND m.status = 'matched'
               AND (m.left_entity_id = $2 OR m.right_entity_id = $2)
          )
          AND currency = $3
          AND (direction IS NOT DISTINCT FROM $4)
          AND due_date >= ($5::timestamptz - make_interval(days => $6))
          AND due_date <= ($5::timestamptz + make_interval(days => $6))
        ORDER BY ABS(EXTRACT(EPOCH FROM (due_date - $5::timestamptz))) ASC
        LIMIT $7`,
      [
        left.id,
        left.counterparty_id,
        left.currency,
        left.direction,
        left.due_date,
        DATE_WINDOW_DAYS,
        MAX_RIGHT_PER_LEFT,
      ],
    );
    return rows;
  });
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
