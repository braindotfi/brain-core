/**
 * Resolved counterparty view (ingestion architecture Phase 4, §11 / §13).
 *
 * The organization-identity companion to resolveObligation.ts: given any
 * counterparty observation, follow confirmed counterparty_duplicate links
 * (transitively — the merchant↔vendor and vendor↔customer links resolve to
 * one organization) and produce one resolved organization with every
 * observation retained verbatim. Pure read-side; reversible by construction.
 *
 * Authority (§13: the user owns intent and approved corrections):
 *  - canonical name: a human_confirmed observation wins; else the
 *    highest-confidence independent (extracted) observation; else the subject.
 *  - types and names are UNIONED as facets, never collapsed: the same org IS
 *    a vendor in AP and a customer in AR — both facts stand.
 *  - name variants across observations are listed as conflicts.
 */

import type { Pool } from "pg";
import { withTenantScope, type ServiceCallContext } from "@brain/shared";

export interface CounterpartyObservationView {
  counterparty_id: string;
  name: string;
  type: string;
  provenance: string;
  confidence: number;
  source_ids: string[];
  metadata: Record<string, unknown>;
}

export interface ResolvedCounterpartyView {
  subject_counterparty_id: string;
  /** Every linked observation, retained verbatim. */
  observations: CounterpartyObservationView[];
  resolved: {
    name: { value: string; authority_counterparty_id: string; authority_provenance: string };
    /** Facets, not a winner: the org can be vendor AND customer AND merchant. */
    types: string[];
    /** All counterparty row ids that resolve to this organization. */
    member_ids: string[];
  };
  /** Distinct display-name variants when observations disagree. */
  name_variants: Array<{ value: string; counterparty_id: string }>;
  matches: Array<{ match_id: string; confidence_score: number }>;
  pending_review: Array<{
    match_id: string;
    counter_counterparty_id: string;
    confidence_score: number;
  }>;
}

const INDEPENDENT = new Set(["extracted", "human_confirmed"]);
const MAX_HOPS = 5;

export async function resolveCounterpartyView(
  pool: Pool,
  ctx: ServiceCallContext,
  counterpartyId: string,
): Promise<ResolvedCounterpartyView | null> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    // 1 — transitive closure over confirmed links (bounded hops), candidates
    //     collected for review without joining the member set.
    const members = new Set<string>([counterpartyId]);
    const matches: ResolvedCounterpartyView["matches"] = [];
    const pendingReview: ResolvedCounterpartyView["pending_review"] = [];
    const seenMatches = new Set<string>();

    let frontier = [counterpartyId];
    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
      const { rows } = await c.query<{
        id: string;
        left_entity_id: string;
        right_entity_id: string;
        status: string;
        confidence_score: number;
      }>(
        `SELECT id, left_entity_id, right_entity_id, status, confidence_score
           FROM ledger_reconciliation_matches
          WHERE match_type = 'counterparty_duplicate'
            AND status IN ('matched','duplicate_possible')
            AND (left_entity_id = ANY($1::text[]) OR right_entity_id = ANY($1::text[]))`,
        [frontier],
      );
      const next: string[] = [];
      for (const m of rows) {
        if (seenMatches.has(m.id)) continue;
        seenMatches.add(m.id);
        const counter = members.has(m.left_entity_id) ? m.right_entity_id : m.left_entity_id;
        if (m.status === "matched") {
          matches.push({ match_id: m.id, confidence_score: m.confidence_score });
          if (!members.has(counter)) {
            members.add(counter);
            next.push(counter);
          }
        } else {
          pendingReview.push({
            match_id: m.id,
            counter_counterparty_id: counter,
            confidence_score: m.confidence_score,
          });
        }
      }
      frontier = next;
    }

    // 2 — load every member observation verbatim.
    const { rows: observations } = await c.query<CounterpartyObservationView>(
      `SELECT id AS counterparty_id, name, type, provenance, confidence,
              source_ids, COALESCE(metadata, '{}'::jsonb) AS metadata
         FROM ledger_counterparties
        WHERE id = ANY($1::text[])`,
      [[...members]],
    );
    if (observations.length === 0) return null;
    const subject = observations.find((o) => o.counterparty_id === counterpartyId);
    if (subject === undefined) return null;

    // 3 — canonical-name authority: human confirmation > strongest
    //     independent observation > the subject itself.
    const authority =
      observations.find((o) => o.provenance === "human_confirmed") ??
      [...observations]
        .filter((o) => INDEPENDENT.has(o.provenance))
        .sort((a, b) => b.confidence - a.confidence)[0] ??
      subject;

    // 4 — name variants listed, never collapsed.
    const variants = new Map<string, string>();
    for (const o of observations) {
      if (!variants.has(o.name)) variants.set(o.name, o.counterparty_id);
    }

    return {
      subject_counterparty_id: counterpartyId,
      observations,
      resolved: {
        name: {
          value: authority.name,
          authority_counterparty_id: authority.counterparty_id,
          authority_provenance: authority.provenance,
        },
        types: [...new Set(observations.map((o) => o.type))].sort(),
        member_ids: [...members].sort(),
      },
      name_variants:
        variants.size > 1
          ? [...variants.entries()].map(([value, id]) => ({ value, counterparty_id: id }))
          : [],
      matches,
      pending_review: pendingReview,
    };
  });
}
