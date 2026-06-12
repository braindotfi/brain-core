/**
 * Reconciliation persistence helpers.
 *
 * Writers all matchers share. Each match insert is idempotent on
 * (owner_id, match_type, left, right) — re-running the matcher returns the
 * existing row. After insert, a `ledger.reconciliation.matched` audit
 * event fires. The matched left-side transaction has its
 * reconciliation_status set to `matched` so the scanner can skip it next run.
 */

import {
  newReconciliationMatchId,
  withTenantScope,
  type AuditEmitter,
  type MatchType,
  type ServiceCallContext,
  type TenantScopedClient,
} from "@brain/shared";
import type { Pool } from "pg";
import type { ReconciliationMatchRow } from "../repository/reconciliation_matches.js";

export interface PersistMatchInput {
  matchType: MatchType;
  leftEntityType: string;
  leftEntityId: string;
  rightEntityType: string;
  rightEntityId: string;
  confidenceScore: number;
  evidenceIds: string[];
  explanation: string;
  /**
   * Phase 4 (§13): `matched` is a confident resolution and triggers the
   * corroboration lift; `duplicate_possible` is a CANDIDATE held for human
   * review (material ambiguity) — the row is recorded, nothing is promoted
   * until ReconciliationService.setStatus confirms it. Default: matched.
   */
  status?: "matched" | "duplicate_possible";
}

export interface PersistMatchResult {
  matchId: string;
  created: boolean;
}

/**
 * RFC 0004 §5.2 / §7.1: corroboration is the sanctioned path to raise an
 * obligation's confidence past the agent-contributed 0.5 ceiling. A single
 * match lifts confidence upward-only toward the match score, capped at 0.9
 * (corroboration never asserts human-confirmed certainty), and promotes
 * `agent_contributed` provenance to `extracted` since the row is now backed
 * by independent Ledger evidence. The 0.9 ceiling and single-match lift are a
 * calibration choice flagged in RFC 0004 §7.1, open to tuning.
 *
 * Batch 10 C-2: the lift is gated on the counter-side row's provenance. The
 * point of corroboration is that "independent Ledger evidence" backs the
 * obligation. If the counter-side row is itself agent_contributed (i.e. the
 * same agent class wrote both the obligation and its "corroborating"
 * transaction), there is no independence; promoting would let the agent
 * self-promote past the 0.5 ceiling it was supposed to be confined to. The
 * counter-side MUST be `extracted` or `human_confirmed` for the lift to fire.
 * Otherwise the match row is still recorded (it is useful evidence for the
 * reconciliation matcher), but the obligation's confidence + provenance are
 * left untouched and no `ledger.obligation.corroborated` audit event fires.
 */
const CORROBORATION_CONFIDENCE_CEILING = 0.9;

/**
 * Provenance values that count as "independent of the agent" for the
 * corroboration write-back. Anything else (agent_contributed, inferred,
 * ambiguous) does NOT corroborate.
 */
const INDEPENDENT_PROVENANCE = new Set(["extracted", "human_confirmed"]);

/**
 * Tables the reconciliation matchers can pair an obligation with. Each entry
 * names the SQL table and the provenance column. Used to look up the
 * counter-side row's provenance before deciding whether to lift the
 * obligation. Centralised here (not embedded in the SQL) so adding a new
 * matcher entity type is a one-line change in one place and the safe default
 * (return null → no lift) holds for any not-yet-mapped type.
 */
const COUNTER_SIDE_PROVENANCE_TABLES: Record<string, string> = {
  transaction: "ledger_transactions",
  invoice: "ledger_invoices",
  document: "ledger_documents",
  balance: "ledger_balances",
  // Phase 4: an obligation corroborated by ANOTHER obligation observation
  // (document payable vs aggregator bill). Independence still gates the lift:
  // the counter obligation must itself be extracted / human_confirmed.
  obligation: "ledger_obligations",
  // Phase 4 entity resolution: a counterparty corroborated by another
  // observation of the same organization from an independent source.
  counterparty: "ledger_counterparties",
  // Phase 4 entity resolution: an account corroborated by another observation
  // of the same money pool (only ever via human-confirmed candidates).
  account: "ledger_accounts",
};

/** Tables whose rows the corroboration lift may update, keyed by entity type. */
const LIFTABLE_TABLES: Record<string, string> = {
  obligation: "ledger_obligations",
  counterparty: "ledger_counterparties",
  account: "ledger_accounts",
};

async function loadCounterSideProvenance(
  c: TenantScopedClient,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  const table = COUNTER_SIDE_PROVENANCE_TABLES[entityType];
  if (table === undefined) return null; // Safe default: unknown type cannot corroborate.
  const { rows } = await c.query<{ provenance: string }>(
    // The table name is whitelisted above (not user input), so interpolation
    // is safe; the id parameter still binds normally.
    `SELECT provenance FROM ${table} WHERE id = $1 LIMIT 1`,
    [entityId],
  );
  return rows[0]?.provenance ?? null;
}

export interface CorroborationSide {
  self: { type: string; id: string };
  counter: { type: string; id: string };
}

/**
 * The corroboration write-back (RFC 0004 §7.1), shared by persistMatch
 * (confident matches) and ReconciliationService.setStatus (a human confirming
 * a duplicate_possible candidate). For each obligation side whose counter
 * side is INDEPENDENT (extracted / human_confirmed), confidence lifts
 * upward-only toward the match score (capped 0.9) and low-trust provenance
 * (agent_contributed / customer_asserted) promotes to extracted.
 */
export async function applyCorroborationLift(
  c: TenantScopedClient,
  sides: CorroborationSide[],
  confidenceScore: number,
): Promise<Array<{ id: string; confidence: number }>> {
  const promoted: Array<{ id: string; confidence: number }> = [];
  for (const { self, counter } of sides) {
    const table = LIFTABLE_TABLES[self.type];
    if (table === undefined) continue;
    const counterProv = await loadCounterSideProvenance(c, counter.type, counter.id);
    if (counterProv === null || !INDEPENDENT_PROVENANCE.has(counterProv)) {
      // No independent corroboration; do not lift. The match row stands.
      continue;
    }
    const { rows } = await c.query<{ id: string; confidence: number }>(
      // Table name whitelisted above (never user input); ids bind normally.
      `UPDATE ${table}
          SET confidence = GREATEST(confidence, LEAST($2::real, $3::real)),
              provenance = CASE WHEN provenance IN ('agent_contributed','customer_asserted')
                                THEN 'extracted' ELSE provenance END,
              updated_at = now()
        WHERE id = $1
        RETURNING id, confidence`,
      [self.id, confidenceScore, CORROBORATION_CONFIDENCE_CEILING],
    );
    const row = rows[0];
    if (row !== undefined) promoted.push(row);
  }
  return promoted;
}

export async function persistMatch(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  input: PersistMatchInput,
): Promise<PersistMatchResult> {
  const promoted: Array<{ id: string; confidence: number }> = [];
  const status = input.status ?? "matched";
  const result = await withTenantScope(pool, ctx.tenantId, async (c) => {
    const existing = await findExistingMatch(c, input);
    if (existing !== null) return { matchId: existing.id, created: false };

    const id = newReconciliationMatchId();
    await c.query(
      `INSERT INTO ledger_reconciliation_matches
         (id, owner_id, match_type,
          left_entity_type, left_entity_id,
          right_entity_type, right_entity_id,
          confidence_score, status, evidence_ids, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        ctx.tenantId,
        input.matchType,
        input.leftEntityType,
        input.leftEntityId,
        input.rightEntityType,
        input.rightEntityId,
        input.confidenceScore,
        status,
        input.evidenceIds,
        input.explanation,
      ],
    );

    // A duplicate_possible CANDIDATE records the link and stops: no
    // transaction marking, no corroboration lift, until a human confirms it
    // (setStatus). Material ambiguity defers to user review (§13).
    if (status !== "matched") {
      return { matchId: id, created: true };
    }

    // Mark the participating ledger_transactions as matched so the next
    // run skips them. Other entity types (invoices, balances, etc.) carry
    // their reconciliation state in their own status column or via the
    // join through this table.
    if (input.leftEntityType === "transaction") {
      await c.query(
        `UPDATE ledger_transactions
            SET reconciliation_status = 'matched', updated_at = now()
          WHERE id = $1 AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')`,
        [input.leftEntityId],
      );
    }
    if (input.rightEntityType === "transaction") {
      await c.query(
        `UPDATE ledger_transactions
            SET reconciliation_status = 'matched', updated_at = now()
          WHERE id = $1 AND (reconciliation_status IS NULL OR reconciliation_status = 'unreconciled')`,
        [input.rightEntityId],
      );
    }

    // Corroboration write-back: an obligation matched against INDEPENDENT
    // evidence earns confidence (upward-only). The independence check (C-2)
    // queries the counter-side row's provenance: only `extracted` or
    // `human_confirmed` rows corroborate. If the counter-side is itself
    // agent_contributed, the match is recorded but the obligation's
    // confidence + provenance stay put. See CORROBORATION_* above.
    const sides = [
      {
        self: { type: input.leftEntityType, id: input.leftEntityId },
        counter: { type: input.rightEntityType, id: input.rightEntityId },
      },
      {
        self: { type: input.rightEntityType, id: input.rightEntityId },
        counter: { type: input.leftEntityType, id: input.leftEntityId },
      },
    ];
    promoted.push(...(await applyCorroborationLift(c, sides, input.confidenceScore)));

    return { matchId: id, created: true };
  });

  if (result.created) {
    await audit.emit({
      tenantId: ctx.tenantId,
      layer: "ledger",
      actor: ctx.actor,
      action: "ledger.reconciliation.matched",
      inputs: {
        match_type: input.matchType,
        left: { type: input.leftEntityType, id: input.leftEntityId },
        right: { type: input.rightEntityType, id: input.rightEntityId },
        confidence: input.confidenceScore,
      },
      outputs: { match_id: result.matchId, explanation: input.explanation },
    });
    // Audit each obligation whose confidence was corroborated, so the trail
    // explains why an obligation later clears `agent.confidence.gte`.
    for (const obligation of promoted) {
      await audit.emit({
        tenantId: ctx.tenantId,
        layer: "ledger",
        actor: ctx.actor,
        action: "ledger.obligation.corroborated",
        inputs: { match_type: input.matchType, match_confidence: input.confidenceScore },
        outputs: { obligation_id: obligation.id, confidence: obligation.confidence },
      });
    }
  }

  return result;
}

async function findExistingMatch(
  c: TenantScopedClient,
  input: PersistMatchInput,
): Promise<ReconciliationMatchRow | null> {
  const { rows } = await c.query<ReconciliationMatchRow>(
    `SELECT * FROM ledger_reconciliation_matches
      WHERE match_type = $1
        AND left_entity_type = $2 AND left_entity_id = $3
        AND right_entity_type = $4 AND right_entity_id = $5
      LIMIT 1`,
    [
      input.matchType,
      input.leftEntityType,
      input.leftEntityId,
      input.rightEntityType,
      input.rightEntityId,
    ],
  );
  return rows[0] ?? null;
}
