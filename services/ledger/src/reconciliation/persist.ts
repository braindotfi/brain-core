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
}

export interface PersistMatchResult {
  matchId: string;
  created: boolean;
}

export async function persistMatch(
  pool: Pool,
  audit: AuditEmitter,
  ctx: ServiceCallContext,
  input: PersistMatchInput,
): Promise<PersistMatchResult> {
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'matched',$9,$10)`,
      [
        id,
        ctx.tenantId,
        input.matchType,
        input.leftEntityType,
        input.leftEntityId,
        input.rightEntityType,
        input.rightEntityId,
        input.confidenceScore,
        input.evidenceIds,
        input.explanation,
      ],
    );

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
