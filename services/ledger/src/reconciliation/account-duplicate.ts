/**
 * account_duplicate matcher (ingestion architecture Phase 4, §13).
 *
 * Pairs account rows that plausibly describe the same money pool observed by
 * different sources (a Plaid bank account vs the ERP's bank-feed account).
 * The compact account schema carries no strong deterministic identity key
 * (no mask / routing data), so this matcher NEVER auto-matches: every link
 * is recorded as a `duplicate_possible` CANDIDATE and a human confirms it
 * via ReconciliationService.setStatus — "do not silently merge on a weak
 * match" applies doubly to money pools, whose identity feeds the §6 gate's
 * balance check. Confirmation then runs the standard independence-gated
 * corroboration lift.
 *
 * Signals: equal currency + account_type are gating; same institution and
 * name similarity score the candidate. People, for the record, are already
 * covered by counterparty_duplicate (employees are counterparty rows).
 */

import { withTenantScope, type ServiceCallContext } from "@brain/shared";
import type { Pool } from "pg";
import { nameScore } from "./scoring.js";
import { persistMatch } from "./persist.js";
import type { Matcher, MatcherContext, MatcherInput, MatcherResult } from "./types.js";

interface AccountRowLite {
  id: string;
  name: string;
  institution: string | null;
  account_type: string;
  currency: string;
  created_at: Date;
}

const CANDIDATE_THRESHOLD = 0.55;
/** Hard ceiling below the confident threshold: accounts never auto-match. */
const CANDIDATE_CEILING = 0.79;
const MAX_RECENT = 100;
const MAX_PEERS_PER_ROW = 10;
const SCAN_WINDOW_DAYS_DEFAULT = 60;

function pairScore(a: AccountRowLite, b: AccountRowLite): number {
  const institution = a.institution !== null && a.institution === b.institution ? 0.4 : 0;
  const name = nameScore(a.name, b.name) * 0.6;
  return Math.min(institution + name, CANDIDATE_CEILING);
}

export class AccountDuplicateMatcher implements Matcher {
  public readonly matchType = "account_duplicate" as const;

  public async run(deps: MatcherContext, input: MatcherInput): Promise<MatcherResult> {
    const since = input.since ?? defaultSince(SCAN_WINDOW_DAYS_DEFAULT);
    const recent = await loadRecentAccounts(deps.pool, input.ctx, since);
    const matches: MatcherResult["matchesProduced"] = [];

    for (const row of recent) {
      if (matches.length >= input.maxMatches) break;

      const peers = await loadUnlinkedPeers(deps.pool, input.ctx, row);
      for (const peer of peers) {
        if (matches.length >= input.maxMatches) break;
        const score = pairScore(row, peer);
        if (score < CANDIDATE_THRESHOLD) continue;

        const [left, right] = row.id < peer.id ? [row, peer] : [peer, row];
        const persisted = await persistMatch(deps.pool, deps.audit, input.ctx, {
          matchType: "account_duplicate",
          leftEntityType: "account",
          leftEntityId: left.id,
          rightEntityType: "account",
          rightEntityId: right.id,
          confidenceScore: score,
          evidenceIds: [],
          status: "duplicate_possible", // money pools always wait for a human
          explanation:
            `account_duplicate: "${left.name}" (${left.institution ?? "?"}) ↔ ` +
            `"${right.name}" (${right.institution ?? "?"}) ` +
            `(score=${score.toFixed(3)}, candidate — requires confirmation)`,
        });
        if (persisted.created) {
          matches.push({
            matchId: persisted.matchId,
            matchType: this.matchType,
            leftEntityType: "account",
            leftEntityId: left.id,
            rightEntityType: "account",
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

async function loadRecentAccounts(
  pool: Pool,
  ctx: ServiceCallContext,
  since: Date,
): Promise<AccountRowLite[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<AccountRowLite>(
      `SELECT id, name, institution, account_type, currency, created_at
         FROM ledger_accounts
        WHERE created_at >= $1 AND status = 'active'
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
  row: AccountRowLite,
): Promise<AccountRowLite[]> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows } = await c.query<AccountRowLite>(
      // Gating keys: same currency AND account_type; never the same row;
      // never an already-linked pair (in either order).
      `SELECT id, name, institution, account_type, currency, created_at
         FROM ledger_accounts peer
        WHERE peer.id <> $1
          AND peer.currency = $2
          AND peer.account_type = $3
          AND peer.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM ledger_reconciliation_matches m
             WHERE m.match_type = 'account_duplicate'
               AND m.status IN ('matched','duplicate_possible')
               AND m.left_entity_id = LEAST($1, peer.id)
               AND m.right_entity_id = GREATEST($1, peer.id)
          )
        LIMIT $4`,
      [row.id, row.currency, row.account_type, MAX_PEERS_PER_ROW],
    );
    return rows;
  });
}

function defaultSince(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
