/**
 * Resolved obligation view (ingestion architecture Phase 4, §11 "Resolved" /
 * §13 authority).
 *
 * A pure READ-SIDE projection: given any observation of a payable, follow
 * the obligation_duplicate match links and produce one reconciled fact —
 * with every observation retained verbatim, conflicts listed rather than
 * overwritten, and each resolved field carrying the authority that produced
 * it. Nothing here mutates rows; resolution is reversible by construction
 * (reject the match and the view falls apart into its observations again).
 *
 * Field-level authority (§13: authority is defined by domain and field, not
 * globally by provider):
 *  - amount_due, due_date, GL classification: the accounting system's
 *    observation (provenance extracted/human_confirmed) is authoritative —
 *    accounting software owns ledger classification and billing terms.
 *  - existence + document linkage: the document observation contributes the
 *    original assertion and its evidence references.
 *  - When only one observation exists, it is authoritative by default.
 *
 * Candidate (duplicate_possible) links are surfaced as `pending_review` so a
 * review UI can ask for the user confirmation §13 requires for material
 * ambiguity; they do NOT contribute authority until confirmed.
 */

import type { Pool } from "pg";
import { withTenantScope, type ServiceCallContext } from "@brain/shared";

export interface ObligationObservationView {
  obligation_id: string;
  provenance: string;
  confidence: number;
  amount_due: string;
  currency: string;
  due_date: string;
  status: string;
  direction: string | null;
  counterparty_id: string;
  source_ids: string[];
  evidence_ids: string[];
  metadata: Record<string, unknown>;
}

export interface ResolvedField<T> {
  value: T;
  /** The observation that authoritatively supplied this value. */
  authority_obligation_id: string;
  authority_provenance: string;
}

export interface ObligationConflict {
  field: "amount_due" | "due_date";
  values: Array<{ value: string; obligation_id: string; provenance: string }>;
}

export interface ResolvedObligationView {
  /** The observation the caller asked about. */
  subject_obligation_id: string;
  /** Every linked observation, retained verbatim (§13: preserve all). */
  observations: ObligationObservationView[];
  /** Resolved fields with per-field authority. */
  resolved: {
    amount_due: ResolvedField<string>;
    currency: ResolvedField<string>;
    due_date: ResolvedField<string>;
    counterparty_id: ResolvedField<string>;
    /** GL coding from the accounting observation's extensions, when present. */
    gl_accounts: ResolvedField<string[]> | null;
  };
  /** Disagreements between observations — listed, never overwritten. */
  conflicts: ObligationConflict[];
  /** Confirmed links backing this view. */
  matches: Array<{ match_id: string; status: string; confidence_score: number }>;
  /** Candidate links awaiting the §13 user confirmation. */
  pending_review: Array<{
    match_id: string;
    counter_obligation_id: string;
    confidence_score: number;
  }>;
}

const INDEPENDENT = new Set(["extracted", "human_confirmed"]);

function glAccountsOf(observation: ObligationObservationView): string[] | null {
  const merge = (observation.metadata as { merge?: { gl_accounts?: unknown } }).merge;
  return Array.isArray(merge?.gl_accounts) ? (merge.gl_accounts as string[]) : null;
}

export async function resolveObligationView(
  pool: Pool,
  ctx: ServiceCallContext,
  obligationId: string,
): Promise<ResolvedObligationView | null> {
  return withTenantScope(pool, ctx.tenantId, async (c) => {
    // 1 — the link set: confirmed + candidate obligation_duplicate matches
    //     touching the subject on either side.
    const { rows: matchRows } = await c.query<{
      id: string;
      left_entity_id: string;
      right_entity_id: string;
      status: string;
      confidence_score: number;
    }>(
      `SELECT id, left_entity_id, right_entity_id, status, confidence_score
         FROM ledger_reconciliation_matches
        WHERE match_type = 'obligation_duplicate'
          AND (left_entity_id = $1 OR right_entity_id = $1)
          AND status IN ('matched','duplicate_possible')`,
      [obligationId],
    );

    const confirmedIds = new Set<string>([obligationId]);
    const pendingReview: ResolvedObligationView["pending_review"] = [];
    for (const m of matchRows) {
      const counter = m.left_entity_id === obligationId ? m.right_entity_id : m.left_entity_id;
      if (m.status === "matched") {
        confirmedIds.add(counter);
      } else {
        pendingReview.push({
          match_id: m.id,
          counter_obligation_id: counter,
          confidence_score: m.confidence_score,
        });
      }
    }

    // 2 — load every confirmed observation verbatim.
    const { rows: observations } = await c.query<ObligationObservationView>(
      `SELECT id AS obligation_id, provenance, confidence, amount_due::TEXT, currency,
              due_date::TEXT AS due_date, status, direction, counterparty_id,
              source_ids, evidence_ids, COALESCE(metadata, '{}'::jsonb) AS metadata
         FROM ledger_obligations
        WHERE id = ANY($1::text[])`,
      [[...confirmedIds]],
    );
    if (observations.length === 0) return null;
    const subject = observations.find((o) => o.obligation_id === obligationId);
    if (subject === undefined) return null;

    // 3 — field-level authority: the independent (accounting-side)
    //     observation wins for amount / due date / GL; fall back to the
    //     subject when no independent observation is linked.
    const authority =
      observations.find((o) => INDEPENDENT.has(o.provenance) && o.obligation_id !== obligationId) ??
      observations.find((o) => INDEPENDENT.has(o.provenance)) ??
      subject;

    const field = <T>(value: T, from: ObligationObservationView): ResolvedField<T> => ({
      value,
      authority_obligation_id: from.obligation_id,
      authority_provenance: from.provenance,
    });

    const glSource = observations.find((o) => glAccountsOf(o) !== null) ?? null;

    // 4 — conflicts: where retained observations disagree, list every value.
    const conflicts: ObligationConflict[] = [];
    for (const f of ["amount_due", "due_date"] as const) {
      const distinct = new Map<string, ObligationObservationView>();
      for (const o of observations) distinct.set(String(o[f]), o);
      if (distinct.size > 1) {
        conflicts.push({
          field: f,
          values: [...distinct.entries()].map(([value, o]) => ({
            value,
            obligation_id: o.obligation_id,
            provenance: o.provenance,
          })),
        });
      }
    }

    return {
      subject_obligation_id: obligationId,
      observations,
      resolved: {
        amount_due: field(authority.amount_due, authority),
        currency: field(authority.currency, authority),
        due_date: field(authority.due_date, authority),
        counterparty_id: field(subject.counterparty_id, subject),
        gl_accounts: glSource !== null ? field(glAccountsOf(glSource)!, glSource) : null,
      },
      conflicts,
      matches: matchRows
        .filter((m) => m.status === "matched")
        .map((m) => ({ match_id: m.id, status: m.status, confidence_score: m.confidence_score })),
      pending_review: pendingReview,
    };
  });
}
