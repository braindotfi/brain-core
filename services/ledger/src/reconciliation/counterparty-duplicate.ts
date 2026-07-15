/**
 * counterparty_duplicate matcher (ingestion architecture Phase 4, §13).
 *
 * Pairs counterparty rows that name the same real-world organization,
 * observed by different connectors under different types: Plaid lands a
 * `merchant`, the accounting aggregator a `vendor`, Stripe a `customer`.
 * Resolution LINKS the observations through a match row — never merges them
 * (§11 "Resolved": uncertainty + reversibility; do not silently merge on a
 * weak match).
 *
 * Matching order follows §13:
 *  - deterministic business key: exact normalized-name equality across rows
 *    of different type or disjoint sources → 0.85 (confident, `matched`)
 *  - identity bonus: equal email in namespaced metadata → +0.1
 *  - probabilistic: normalized-prefix block, then nameScore containment /
 *    token overlap → candidate territory (`duplicate_possible`, §13 user
 *    review)
 *
 * Symmetric identity matching: each unordered pair is considered once, with
 * sides ordered by row id so findExistingMatch's (left, right) dedup key is
 * deterministic (no A↔B plus B↔A duplicates).
 */

import { withTenantScope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { nameScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface CounterpartyRow {
  id: string;
  name: string;
  normalized_name: string | null;
  type: string;
  provenance: string;
  confidence: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const CONFIDENT_THRESHOLD = 0.8;
const CANDIDATE_THRESHOLD = 0.55;
const EXACT_NAME_SCORE = 0.85;
const EMAIL_BONUS = 0.1;
const MAX_RECENT = 100;
const MAX_PEERS_PER_ROW = 10;
const SCAN_WINDOW_DAYS_DEFAULT = 60;

function emailOf(row: CounterpartyRow): string | null {
  for (const ns of Object.values(row.metadata)) {
    if (typeof ns !== "object" || ns === null) continue;
    const email = (ns as { email?: unknown }).email;
    if (typeof email === "string" && email.includes("@")) return email.toLowerCase();
  }
  return null;
}

function pairScore(a: CounterpartyRow, b: CounterpartyRow): number {
  const exact =
    a.normalized_name !== null && a.normalized_name === b.normalized_name
      ? EXACT_NAME_SCORE
      : nameScore(a.name, b.name) * 0.8; // probabilistic tier tops out below confident
  const emailA = emailOf(a);
  const bonus = emailA !== null && emailA === emailOf(b) ? EMAIL_BONUS : 0;
  return Math.min(exact + bonus, 0.95);
}

export class CounterpartyDuplicateMatcher implements Matcher {
  public readonly matchType = "counterparty_duplicate" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const recent = await loadRecentCounterparties(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const row of recent) {
      if (matches.length >= input.maxMatches) break;

      const peers = await loadUnlinkedPeers(deps.pool, input.ctx, row);
      for (const peer of peers) {
        if (matches.length >= input.maxMatches) break;
        const score = pairScore(row, peer);
        if (score < CANDIDATE_THRESHOLD) continue;

        // Deterministic side ordering for the symmetric pair.
        const [left, right] = row.id < peer.id ? [row, peer] : [peer, row];
        const status = score >= CONFIDENT_THRESHOLD ? "matched" : "duplicate_possible";
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "counterparty_duplicate",
          leftEntityType: "counterparty",
          leftEntityId: left.id,
          rightEntityType: "counterparty",
          rightEntityId: right.id,
          confidenceScore: score,
          evidenceIds: [],
          status,
          explanation:
            `counterparty_duplicate: "${left.name}" (${left.type}) ↔ "${right.name}" ` +
            `(${right.type}) (score=${score.toFixed(3)}, ${status})`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "counterparty",
            leftEntityId: left.id,
            rightEntityType: "counterparty",
            rightEntityId: right.id,
            confidenceScore: score,
          });
        }
      }
    }

    return {
      matchType: this.matchType,
      matchesProduced: matches,
      candidatesScanned: recent.length,
    };
  }
}

async function loadRecentCounterparties(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<CounterpartyRow[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<CounterpartyRow>(
      `SELECT id, name, normalized_name, type, provenance, confidence,
              COALESCE(metadata, '{}'::jsonb) AS metadata, created_at
         FROM ledger_counterparties
        WHERE created_at >= $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [since, MAX_RECENT],
    );
    return rows;
  });
}

async function loadUnlinkedPeers(
  pool: Pool,
  ctx: ServiceCallContext,
  row: CounterpartyRow,
): Promise<CounterpartyRow[]> {
  if (row.normalized_name === null) return [];
  const prefix = blockingPrefix(row.normalized_name);
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<CounterpartyRow>(
      // Peer candidates: exact normalized-name peers for the deterministic
      // tier, plus normalized-prefix peers for the probabilistic tier. The
      // prefix block is backed by the text_pattern_ops index in ledger/0045 so
      // fuzzy matching is reachable without scanning the whole table.
      `SELECT id, name, normalized_name, type, provenance, confidence,
              COALESCE(metadata, '{}'::jsonb) AS metadata, created_at
         FROM ledger_counterparties peer
        WHERE peer.id <> $1
          AND peer.normalized_name IS NOT NULL
          AND (peer.normalized_name = $2 OR peer.normalized_name LIKE $3)
          AND NOT EXISTS (
            SELECT 1 FROM ledger_reconciliation_matches m
             WHERE m.match_type = 'counterparty_duplicate'
               AND m.status IN ('matched','duplicate_possible')
               AND ((m.left_entity_id = LEAST($1, peer.id) AND m.right_entity_id = GREATEST($1, peer.id)))
          )
        LIMIT $4`,
      [row.id, row.normalized_name, `${prefix}%`, MAX_PEERS_PER_ROW],
    );
    return rows;
  });
}

function blockingPrefix(normalizedName: string): string {
  const [firstToken] = normalizedName.split("_");
  const token = firstToken ?? normalizedName;
  return token.length >= 3 ? token : normalizedName.slice(0, 3);
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
