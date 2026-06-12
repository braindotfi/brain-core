/**
 * ReconciliationService — implements IReconciliationService.
 *
 * Hosts the matcher registry and exposes:
 *   run(ctx, req)       — execute matchers for the requested types
 *   list(ctx, filters)  — read ledger_reconciliation_matches
 *   setStatus(ctx, ...) — manual override of a match's status
 *
 * §10 of architecture says reconciliation runs continuously via the
 * reconciliation-agent. Phase 5 ships the synchronous run path; the
 * BullMQ scheduler that calls run() on a cron lands in stage-8 infra
 * alongside the rest of the agent worker wiring.
 */

import {
  brainError,
  emitDomainEvent,
  withTenantScope,
  type AuditEmitter,
  type IReconciliationService,
  type MatchType,
  type ReconciliationMatch,
  type RoutingEnqueue,
  type RunReconciliationRequest,
  type ServiceCallContext,
} from "@brain/shared";
import type { Pool } from "pg";
import { listReconciliationMatches } from "../repository/reconciliation_matches.js";
import { applyCorroborationLift } from "./persist.js";
import { InvoicePaymentMatcher } from "./invoice-payment.js";
import { TransactionReceiptMatcher } from "./transaction-receipt.js";
import { StatementBalanceMatcher } from "./statement-balance.js";
import { WalletTransferMatcher } from "./wallet-transfer.js";
import { PayrollBankDebitMatcher } from "./payroll-bank-debit.js";
import { SubscriptionChargeMatcher } from "./subscription-charge.js";
import { CardChargeMatcher } from "./card-charge.js";
import { OnchainSettlementMatcher } from "./onchain-settlement.js";
import { ObligationDuplicateMatcher } from "./obligation-duplicate.js";
import type { Matcher, MatcherResult } from "./types.js";

export interface ReconciliationServiceDeps {
  pool: Pool;
  audit: AuditEmitter;
  /** Hard cap on matches written per matcher per run. */
  maxMatchesPerMatcher?: number;
  /**
   * Optional: routing enqueue for agent-router domain events (Phase 1). When
   * wired, a run that produces matches emits `reconciliation.candidate_found`
   * so the router can route to the reconciliation agent. Absent ⇒ no event.
   */
  enqueue?: RoutingEnqueue;
}

const DEFAULT_MAX_MATCHES = 200;

export class ReconciliationService implements IReconciliationService {
  private readonly registry: Map<MatchType, Matcher>;

  public constructor(private readonly deps: ReconciliationServiceDeps) {
    const matchers: Matcher[] = [
      new InvoicePaymentMatcher(),
      new TransactionReceiptMatcher(),
      new StatementBalanceMatcher(),
      new WalletTransferMatcher(),
      new PayrollBankDebitMatcher(),
      new SubscriptionChargeMatcher(),
      new CardChargeMatcher(),
      new OnchainSettlementMatcher(),
      new ObligationDuplicateMatcher(),
    ];
    this.registry = new Map(matchers.map((m) => [m.matchType, m]));
  }

  public async run(
    ctx: ServiceCallContext,
    req: RunReconciliationRequest,
  ): Promise<{ job_id: string }> {
    const types = req.match_types ?? Array.from(this.registry.keys());
    const since = req.since !== undefined ? new Date(req.since) : null;
    const max = this.deps.maxMatchesPerMatcher ?? DEFAULT_MAX_MATCHES;

    // Validate requested types before taking the lock.
    for (const t of types) {
      if (!this.registry.has(t)) {
        throw brainError("request_body_invalid", `unknown match_type: ${t}`);
      }
    }

    // 2.5: coordinate concurrent reconciliation across replicas with a per-tenant
    // advisory lock. The matchers run in separate txs, so a session-scoped lock
    // (held across the batch, then explicitly released) is used rather than an
    // xact-scoped one. If another replica holds it, skip cleanly — the next
    // scheduled run catches up; no double-write to ledger_reconciliation_matches.
    const lockClient = await this.deps.pool.connect();
    let locked = false;
    try {
      const res = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hash_text($1)) AS locked",
        [ctx.tenantId],
      );
      locked = res.rows[0]?.locked === true;
      if (!locked) {
        await this.deps.audit.emit({
          tenantId: ctx.tenantId,
          layer: "ledger",
          actor: ctx.actor,
          action: "ledger.reconciliation.skipped_locked",
          inputs: { match_types: types },
          outputs: { reason: "another replica holds the tenant reconciliation lock" },
        });
        return { job_id: `recon_skipped_${Date.now().toString(36)}` };
      }

      const summary: Array<MatcherResult> = [];
      for (const t of types) {
        const matcher = this.registry.get(t)!;
        const result = await matcher.run(
          { pool: this.deps.pool, audit: this.deps.audit },
          { ctx, since, maxMatches: max },
        );
        summary.push(result);
      }

      const totalCreated = summary.reduce((acc, r) => acc + r.matchesProduced.length, 0);
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "ledger",
        actor: ctx.actor,
        action: "ledger.reconciliation.run",
        inputs: { match_types: types, since: since?.toISOString() ?? null },
        outputs: {
          matchers_run: summary.length,
          matches_created: totalCreated,
          per_matcher: summary.map((s) => ({
            match_type: s.matchType,
            created: s.matchesProduced.length,
            scanned: s.candidatesScanned,
            ...(s.notes !== undefined ? { notes: s.notes } : {}),
          })),
        },
      });

      // Domain-event producer (agent-router Phase 1): when matches are found,
      // emit `reconciliation.candidate_found` so the router can route to the
      // reconciliation agent. Best-effort — the run is already audited; a queue
      // hiccup must not fail reconciliation.
      if (totalCreated > 0 && this.deps.enqueue !== undefined) {
        void emitDomainEvent(this.deps.enqueue, {
          tenantId: ctx.tenantId,
          event: "reconciliation.candidate_found",
          context: { matches_created: totalCreated, match_types: types },
          ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
        }).catch(() => undefined);
      }

      // Phase 5 returns a synthetic job id; stage-8 wires this through BullMQ
      // and returns the actual job id from the queue.
      return { job_id: `recon_${Date.now().toString(36)}` };
    } finally {
      if (locked) {
        await lockClient.query("SELECT pg_advisory_unlock(hash_text($1))", [ctx.tenantId]);
      }
      lockClient.release();
    }
  }

  public async list(
    ctx: ServiceCallContext,
    f: { status?: ReconciliationMatch["status"]; match_type?: MatchType; limit?: number },
  ): Promise<ReconciliationMatch[]> {
    const limit = Math.min(f.limit ?? 100, 500);
    const rows = await withTenantScope(this.deps.pool, ctx.tenantId, (c) =>
      listReconciliationMatches(c, {
        ...(f.status !== undefined ? { status: f.status } : {}),
        ...(f.match_type !== undefined ? { match_type: f.match_type } : {}),
        limit,
      }),
    );
    return rows.map(toRecord);
  }

  public async setStatus(
    ctx: ServiceCallContext,
    matchId: string,
    next: ReconciliationMatch["status"],
    explanation?: string,
  ): Promise<ReconciliationMatch> {
    const outcome = await withTenantScope(this.deps.pool, ctx.tenantId, async (c) => {
      const { rows } = await c.query<{
        id: string;
        owner_id: string;
        match_type: string;
        left_entity_type: string;
        left_entity_id: string;
        right_entity_type: string;
        right_entity_id: string;
        confidence_score: number;
        status: string;
        evidence_ids: string[];
        explanation: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `UPDATE ledger_reconciliation_matches
            SET status = $1,
                explanation = COALESCE($2, explanation),
                updated_at = now()
          WHERE id = $3

          RETURNING *`,
        [next, explanation ?? null, matchId],
      );
      const row = rows[0] ?? null;
      if (row === null)
        return { row: null, promoted: [] as Array<{ id: string; confidence: number }> };

      // Phase 4 (§13): a human CONFIRMING a duplicate_possible candidate is
      // the user-review path for material ambiguity. Confirmation triggers
      // the same corroboration lift a confident matcher run would have —
      // upward-only, independence-gated, fully audited. Any other transition
      // (disputed, unmatched, cleared, reversed) records the decision without
      // touching the linked rows: observations stay reversible, never merged.
      let promoted: Array<{ id: string; confidence: number }> = [];
      if (next === "matched") {
        promoted = await applyCorroborationLift(
          c,
          [
            {
              self: { type: row.left_entity_type, id: row.left_entity_id },
              counter: { type: row.right_entity_type, id: row.right_entity_id },
            },
            {
              self: { type: row.right_entity_type, id: row.right_entity_id },
              counter: { type: row.left_entity_type, id: row.left_entity_id },
            },
          ],
          row.confidence_score,
        );
      }
      return { row, promoted };
    });
    if (outcome.row === null) {
      throw brainError("ledger_row_not_found", "no such reconciliation match");
    }
    await this.deps.audit.emit({
      tenantId: ctx.tenantId,
      layer: "ledger",
      actor: ctx.actor,
      action: "ledger.reconciliation.set_status",
      inputs: { match_id: matchId, next, explanation: explanation ?? null },
      outputs: { match_id: matchId, promoted: outcome.promoted.length },
    });
    for (const obligation of outcome.promoted) {
      await this.deps.audit.emit({
        tenantId: ctx.tenantId,
        layer: "ledger",
        actor: ctx.actor,
        action: "ledger.obligation.corroborated",
        inputs: { match_id: matchId, confirmed_by: ctx.actor },
        outputs: { obligation_id: obligation.id, confidence: obligation.confidence },
      });
    }
    return toRecord(outcome.row);
  }
}

function toRecord(row: {
  id: string;
  owner_id: string;
  match_type: string;
  left_entity_type: string;
  left_entity_id: string;
  right_entity_type: string;
  right_entity_id: string;
  confidence_score: number;
  status: string;
  evidence_ids: string[];
  explanation: string | null;
  created_at: Date;
  updated_at: Date;
}): ReconciliationMatch {
  return {
    id: row.id,
    owner_id: row.owner_id,
    match_type: row.match_type as ReconciliationMatch["match_type"],
    left_entity_type: row.left_entity_type as ReconciliationMatch["left_entity_type"],
    left_entity_id: row.left_entity_id,
    right_entity_type: row.right_entity_type as ReconciliationMatch["right_entity_type"],
    right_entity_id: row.right_entity_id,
    confidence_score: row.confidence_score,
    status: row.status as ReconciliationMatch["status"],
    evidence_ids: row.evidence_ids,
    explanation: row.explanation,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
