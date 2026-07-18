/**
 * Resolved account view (ingestion architecture Phase 4, §11 / §13).
 *
 * The money-pool companion to resolveCounterparty.ts: follow CONFIRMED
 * account_duplicate links (the matcher only ever produces candidates, so a
 * confirmed link always means a human reviewed it) into one resolved account
 * with every observation retained. Balances are reported per observation —
 * sources legitimately disagree by timing, so balance variance is the
 * observation list, not a conflict to adjudicate here. Candidates surface as
 * pending_review.
 *
 * Authority: human_confirmed observation > strongest independent; the §6
 * gate keeps reading individual account rows — this view is for review and
 * Wiki surfaces, never a gate input.
 */

import type { Pool } from "pg";
import { withTenantScope, type ServiceCallContext } from "@brain/shared";

export interface AccountObservationView {
  account_id: string;
  external_account_id: string | null;
  name: string;
  institution: string | null;
  account_type: string;
  currency: string;
  current_balance: string | null;
  available_balance: string | null;
  provenance: string;
  confidence: number;
  source_ids: string[];
}

export interface ResolvedAccountView {
  subject_account_id: string;
  observations: AccountObservationView[];
  resolved: {
    name: { value: string; authority_account_id: string; authority_provenance: string };
    account_type: string;
    currency: string;
    member_ids: string[];
  };
  matches: Array<{ match_id: string; confidence_score: number }>;
  pending_review: Array<{ match_id: string; counter_account_id: string; confidence_score: number }>;
}

const INDEPENDENT = new Set(["extracted", "human_confirmed"]);

export async function resolveAccountView(
  pool: Pool,
  ctx: ServiceCallContext,
  accountId: string,
): Promise<ResolvedAccountView | null> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    const { rows: matchRows } = await c.query<{
      id: string;
      left_entity_id: string;
      right_entity_id: string;
      status: string;
      confidence_score: number;
    }>(
      `SELECT id, left_entity_id, right_entity_id, status, confidence_score
         FROM ledger_reconciliation_matches
        WHERE match_type = 'account_duplicate'
          AND (left_entity_id = $1 OR right_entity_id = $1)
          AND status IN ('matched','duplicate_possible')`,
      [accountId],
    );

    const members = new Set<string>([accountId]);
    const matches: ResolvedAccountView["matches"] = [];
    const pendingReview: ResolvedAccountView["pending_review"] = [];
    for (const m of matchRows) {
      const counter = m.left_entity_id === accountId ? m.right_entity_id : m.left_entity_id;
      if (m.status === "matched") {
        members.add(counter);
        matches.push({ match_id: m.id, confidence_score: m.confidence_score });
      } else {
        pendingReview.push({
          match_id: m.id,
          counter_account_id: counter,
          confidence_score: m.confidence_score,
        });
      }
    }

    const { rows: observations } = await c.query<AccountObservationView>(
      `SELECT id AS account_id, external_account_id, name, institution, account_type,
              currency, current_balance::TEXT, available_balance::TEXT, provenance, confidence,
              source_ids
         FROM ledger_accounts
        WHERE id = ANY($1::text[])`,
      [[...members]],
    );
    if (observations.length === 0) return null;
    const subject = observations.find((o) => o.account_id === accountId);
    if (subject === undefined) return null;

    const authority =
      observations.find((o) => o.provenance === "human_confirmed") ??
      [...observations]
        .filter((o) => INDEPENDENT.has(o.provenance))
        .sort((a, b) => b.confidence - a.confidence)[0] ??
      subject;

    return {
      subject_account_id: accountId,
      observations,
      resolved: {
        name: {
          value: authority.name,
          authority_account_id: authority.account_id,
          authority_provenance: authority.provenance,
        },
        account_type: subject.account_type,
        currency: subject.currency,
        member_ids: [...members].sort(),
      },
      matches,
      pending_review: pendingReview,
    };
  });
}
